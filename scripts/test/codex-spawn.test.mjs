import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  buildCodexSpawnSpec,
  requiresNodeScriptCodexBin,
  requiresShellWrappedCodexBin,
} from "../dist/codex-spawn.mjs";

test("requiresNodeScriptCodexBin matches js entrypoints only", () => {
  assert.equal(requiresNodeScriptCodexBin("C:/tools/codex.js"), true);
  assert.equal(requiresNodeScriptCodexBin("C:/tools/codex.mjs"), true);
  assert.equal(requiresNodeScriptCodexBin("C:/tools/codex.cjs"), true);
  assert.equal(requiresNodeScriptCodexBin("C:/tools/codex.exe"), false);
  assert.equal(requiresNodeScriptCodexBin("C:/tools/codex.cmd"), false);
});

test("requiresShellWrappedCodexBin matches Windows batch launchers only", () => {
  assert.equal(requiresShellWrappedCodexBin("C:/tools/codex.cmd", "win32"), true);
  assert.equal(requiresShellWrappedCodexBin("C:/tools/codex.bat", "win32"), true);
  assert.equal(requiresShellWrappedCodexBin("C:/tools/codex.exe", "win32"), false);
  assert.equal(requiresShellWrappedCodexBin("C:/tools/codex.js", "win32"), false);
});

test("buildCodexSpawnSpec routes js entrypoints through node", () => {
  const spec = buildCodexSpawnSpec({
    codexBin: "C:/Users/amine/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    args: ["login", "status"],
    platform: "win32",
    nodeBin: process.execPath,
  });

  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, [
    "C:/Users/amine/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    "login",
    "status",
  ]);
  assert.equal(spec.shell, false);
});

test("buildCodexSpawnSpec keeps exe direct and cmd shell-wrapped", () => {
  const exeSpec = buildCodexSpawnSpec({
    codexBin: "C:/tools/codex.exe",
    args: ["--version"],
    platform: "win32",
  });
  assert.equal(exeSpec.command, "C:/tools/codex.exe");
  assert.deepEqual(exeSpec.args, ["--version"]);
  assert.equal(exeSpec.shell, false);

  const cmdSpec = buildCodexSpawnSpec({
    codexBin: "C:/tools/codex.cmd",
    args: ["login", "status"],
    platform: "win32",
  });
  assert.equal(cmdSpec.shell, true);
  assert.equal(cmdSpec.args.length, 0);
  assert.match(cmdSpec.command, /^"C:\/tools\/codex\.cmd" "login" "status"$/);
});
