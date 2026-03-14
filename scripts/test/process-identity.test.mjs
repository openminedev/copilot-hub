import assert from "node:assert/strict";
import test from "node:test";
import { matchesManagedProcessState, normalizePid } from "../dist/process-identity.mjs";

test("normalizePid accepts valid positive integers only", () => {
  assert.equal(normalizePid("123"), 123);
  assert.equal(normalizePid(0), 0);
  assert.equal(normalizePid(-1), 0);
  assert.equal(normalizePid("abc"), 0);
});

test("matchesManagedProcessState accepts a matching managed daemon process", () => {
  const state = {
    pid: 2444,
    startedAt: "2026-03-14T16:13:37.301Z",
    executablePath: "C:/Program Files/nodejs/node.exe",
    entryScript: "C:/Users/amine/Desktop/copilot_hub/scripts/dist/daemon.mjs",
  };
  const identity = {
    pid: 2444,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    commandLine:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\amine\\Desktop\\copilot_hub\\scripts\\dist\\daemon.mjs" run',
    startedAt: "2026-03-14T16:13:37.900Z",
  };

  assert.equal(matchesManagedProcessState(state, identity, "win32"), true);
});

test("matchesManagedProcessState rejects a reused pid for an unrelated process", () => {
  const state = {
    pid: 2444,
    startedAt: "2026-03-14T16:13:37.301Z",
    command:
      "C:\\Program Files\\nodejs\\node.exe C:\\Users\\amine\\Desktop\\copilot_hub\\scripts\\dist\\daemon.mjs run",
  };
  const identity = {
    pid: 2444,
    executablePath: "C:\\Windows\\System32\\IntelCpHDCPSvc.exe",
    commandLine: "C:\\Windows\\System32\\IntelCpHDCPSvc.exe",
    startedAt: "2026-03-14T16:55:00.000Z",
  };

  assert.equal(matchesManagedProcessState(state, identity, "win32"), false);
});

test("matchesManagedProcessState supports legacy states that only stored command", () => {
  const state = {
    pid: 17044,
    startedAt: "2026-03-14T12:00:00.000Z",
    command: "/usr/bin/node /opt/copilot-hub/scripts/dist/daemon.mjs run",
  };
  const identity = {
    pid: 17044,
    executablePath: "/usr/bin/node",
    commandLine: "/usr/bin/node /opt/copilot-hub/scripts/dist/daemon.mjs run",
    startedAt: "Fri Mar 14 12:00:00 2026",
  };

  assert.equal(matchesManagedProcessState(state, identity, "linux"), true);
});
