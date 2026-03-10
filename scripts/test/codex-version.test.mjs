import assert from "node:assert/strict";
import test from "node:test";
import { compareSemver, isCodexVersionCompatible } from "../dist/codex-version.mjs";

test("isCodexVersionCompatible accepts only validated stable 0.113.x releases", () => {
  assert.equal(isCodexVersionCompatible("0.113.0"), true);
  assert.equal(isCodexVersionCompatible("0.113.9"), true);
  assert.equal(isCodexVersionCompatible("0.112.9"), false);
  assert.equal(isCodexVersionCompatible("0.114.0"), false);
});

test("isCodexVersionCompatible rejects prerelease builds outside the validated lane", () => {
  assert.equal(isCodexVersionCompatible("0.113.1-alpha.1"), false);
  assert.equal(isCodexVersionCompatible("0.114.0-alpha.1"), false);
});

test("compareSemver keeps prerelease ordering stable", () => {
  assert.equal(compareSemver("0.113.0", "0.113.0"), 0);
  assert.equal(compareSemver("0.113.1", "0.113.0"), 1);
  assert.equal(compareSemver("0.113.0-alpha.1", "0.113.0-alpha.2"), -1);
});
