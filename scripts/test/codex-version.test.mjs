import assert from "node:assert/strict";
import test from "node:test";
import {
  codexInstallPackageSpec,
  compareSemver,
  isCodexVersionCompatible,
  preferredCodexVersion,
} from "../dist/codex-version.mjs";

test("isCodexVersionCompatible accepts validated stable 0.113.x through 0.116.x releases", () => {
  assert.equal(isCodexVersionCompatible("0.113.0"), true);
  assert.equal(isCodexVersionCompatible("0.114.0"), true);
  assert.equal(isCodexVersionCompatible("0.115.3"), true);
  assert.equal(isCodexVersionCompatible("0.116.9"), true);
  assert.equal(isCodexVersionCompatible("0.112.9"), false);
  assert.equal(isCodexVersionCompatible("0.117.0"), false);
});

test("isCodexVersionCompatible rejects prerelease builds outside the validated lane", () => {
  assert.equal(isCodexVersionCompatible("0.113.1-alpha.1"), false);
  assert.equal(isCodexVersionCompatible("0.116.0-alpha.1"), false);
  assert.equal(isCodexVersionCompatible("0.117.0-alpha.1"), false);
});

test("preferred install target stays inside the validated compatibility lane", () => {
  assert.equal(preferredCodexVersion, "0.116.0");
  assert.equal(codexInstallPackageSpec, "@openai/codex@0.116.0");
  assert.equal(isCodexVersionCompatible(preferredCodexVersion), true);
});

test("compareSemver keeps prerelease ordering stable", () => {
  assert.equal(compareSemver("0.113.0", "0.113.0"), 0);
  assert.equal(compareSemver("0.113.1", "0.113.0"), 1);
  assert.equal(compareSemver("0.113.0-alpha.1", "0.113.0-alpha.2"), -1);
});
