import assert from "node:assert/strict";
import test from "node:test";
import { mergeProviderOptions } from "../dist/provider-options.js";

test("mergeProviderOptions preserves existing values and trims strings", () => {
  const merged = mergeProviderOptions(
    {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      extra: "keep-me",
    },
    {
      approvalPolicy: " on-failure ",
      customFlag: true,
    },
  );

  assert.deepEqual(merged, {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-failure",
    extra: "keep-me",
    customFlag: true,
  });
});

test("mergeProviderOptions clears model on auto-like values", () => {
  const merged = mergeProviderOptions(
    {
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
    },
    {
      model: "auto",
    },
  );

  assert.equal(Object.prototype.hasOwnProperty.call(merged, "model"), false);
  assert.equal(merged.sandboxMode, "workspace-write");
});
