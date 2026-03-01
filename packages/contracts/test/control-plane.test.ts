import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_ACTION_LIST,
  CONTROL_ACTIONS,
  isControlAction,
  normalizeControlAction,
  requireControlAction,
} from "../dist/control-plane.js";

test("CONTROL_ACTION_LIST is unique and contains declared actions", () => {
  assert.equal(new Set(CONTROL_ACTION_LIST).size, CONTROL_ACTION_LIST.length);
  assert.ok(CONTROL_ACTION_LIST.includes(CONTROL_ACTIONS.BOTS_LIST));
  assert.ok(CONTROL_ACTION_LIST.includes(CONTROL_ACTIONS.EXTENSIONS_CONTRACT_GET));
});

test("normalizeControlAction trims and lower-cases actions", () => {
  assert.equal(normalizeControlAction("  BOTS:LIST "), "bots:list");
  assert.equal(normalizeControlAction(null), "");
});

test("isControlAction validates known and unknown actions", () => {
  assert.equal(isControlAction("bots:list"), true);
  assert.equal(isControlAction(" BOTS:LIST "), true);
  assert.equal(isControlAction("bots:unknown"), false);
  assert.equal(isControlAction(""), false);
});

test("requireControlAction returns normalized action and throws for invalid values", () => {
  assert.equal(requireControlAction(" BOTS:STATUS "), "bots:status");
  assert.throws(
    () => requireControlAction("unknown:action"),
    /Unsupported control action 'unknown:action'/,
  );
  assert.throws(() => requireControlAction(""), /Unsupported control action '<empty>'/);
});
