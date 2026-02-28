#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const targetDirArg = String(process.argv[2] ?? "dist/test").trim() || "dist/test";
const targetDir = path.resolve(process.cwd(), targetDirArg);

if (!fs.existsSync(targetDir)) {
  console.error(`Test directory not found: ${targetDir}`);
  process.exit(1);
}

const testFiles = listTestFiles(targetDir);
if (testFiles.length === 0) {
  console.error(`No test files found under: ${targetDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  shell: false,
});

const code = Number.isInteger(result.status) ? result.status : 1;
process.exit(code);

function listTestFiles(rootDir) {
  const out = [];
  walk(rootDir, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function walk(dirPath, out) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".test.js")) {
      continue;
    }
    out.push(absolutePath);
  }
}
