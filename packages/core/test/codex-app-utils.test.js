import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNodeScriptSpawnArgs,
  buildShellWrappedCommandLine,
  requiresNodeScriptSpawn,
  requiresShellWrappedSpawn,
} from "../dist/codex-app-utils.js";

test("requiresShellWrappedSpawn only enables shell wrapping for Windows batch launchers", () => {
  assert.equal(
    requiresShellWrappedSpawn("C:/Users/amine/AppData/Roaming/npm/codex.cmd", "win32"),
    true,
  );
  assert.equal(requiresShellWrappedSpawn("C:/tools/codex.bat", "win32"), true);
  assert.equal(requiresShellWrappedSpawn("C:/tools/codex.exe", "win32"), false);
  assert.equal(requiresShellWrappedSpawn("/usr/local/bin/codex", "linux"), false);
});

test("buildShellWrappedCommandLine quotes the command and each argument", () => {
  const commandLine = buildShellWrappedCommandLine("C:/Program Files/nodejs/codex.cmd", [
    "login",
    "--device-auth",
    "--profile",
    "default user",
  ]);

  assert.equal(
    commandLine,
    [
      '"C:/Program Files/nodejs/codex.cmd"',
      '"login"',
      '"--device-auth"',
      '"--profile"',
      '"default user"',
    ].join(" "),
  );
});

test("requiresNodeScriptSpawn only enables node wrapping for js entrypoints", () => {
  assert.equal(
    requiresNodeScriptSpawn(
      "C:/Users/amine/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    ),
    true,
  );
  assert.equal(requiresNodeScriptSpawn("C:/tools/codex.mjs"), true);
  assert.equal(requiresNodeScriptSpawn("C:/tools/codex.cjs"), true);
  assert.equal(requiresNodeScriptSpawn("C:/tools/codex.exe"), false);
  assert.equal(requiresNodeScriptSpawn("C:/tools/codex.cmd"), false);
});

test("buildNodeScriptSpawnArgs prepends the script path before codex args", () => {
  const args = buildNodeScriptSpawnArgs(
    "C:/Users/amine/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    ["login", "--device-auth"],
  );

  assert.deepEqual(args, [
    "C:/Users/amine/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    "login",
    "--device-auth",
  ]);
});
