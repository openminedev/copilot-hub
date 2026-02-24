#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const nodeBin = process.execPath;

const action = String(process.argv[2] ?? "start").trim().toLowerCase();

switch (action) {
  case "start": {
    runNode(["scripts/configure.mjs", "--required-only"]);
    runNode(["scripts/supervisor.mjs", "up"]);
    break;
  }
  case "stop": {
    runNode(["scripts/supervisor.mjs", "down"]);
    break;
  }
  case "restart": {
    runNode(["scripts/supervisor.mjs", "restart"]);
    break;
  }
  case "status": {
    runNode(["scripts/supervisor.mjs", "status"]);
    break;
  }
  case "logs": {
    runNode(["scripts/supervisor.mjs", "logs"]);
    break;
  }
  case "configure": {
    runNode(["scripts/configure.mjs"]);
    break;
  }
  default: {
    printUsage();
    process.exit(1);
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

function printUsage() {
  console.log("Usage: node scripts/cli.mjs <start|stop|restart|status|logs|configure>");
}
