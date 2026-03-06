import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateSpawnError,
  normalizeApprovalDecision,
  normalizeApprovalPolicy,
  normalizeModel,
  normalizeSandboxMode,
  normalizeTurnInputItems,
  toRequestId,
  toRpcId,
} from "../dist/codex-app-utils.js";

test("normalizeSandboxMode and normalizeApprovalPolicy keep safe defaults", () => {
  assert.equal(normalizeSandboxMode(undefined), "danger-full-access");
  assert.equal(normalizeSandboxMode("workspace-write"), "workspace-write");
  assert.equal(normalizeSandboxMode("bad-value"), "danger-full-access");

  assert.equal(normalizeApprovalPolicy(undefined), "never");
  assert.equal(normalizeApprovalPolicy("on-request"), "on-request");
  assert.equal(normalizeApprovalPolicy("bad-value"), "never");
});

test("normalizeModel and normalizeApprovalDecision parse aliases", () => {
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel("auto"), null);
  assert.equal(normalizeModel("default"), null);
  assert.equal(normalizeModel("gpt-5"), "gpt-5");

  assert.equal(normalizeApprovalDecision("approve"), "accept");
  assert.equal(normalizeApprovalDecision("always"), "acceptForSession");
  assert.equal(normalizeApprovalDecision("deny"), "decline");
  assert.equal(normalizeApprovalDecision("abort"), "cancel");
  assert.throws(() => normalizeApprovalDecision("unknown"));
});

test("normalizeTurnInputItems enforces non-empty prompt or media payload", () => {
  const withPrompt = normalizeTurnInputItems({ prompt: "hello", inputItems: [] });
  assert.equal(withPrompt.length, 1);
  assert.equal(withPrompt[0].type, "text");

  const withImage = normalizeTurnInputItems({
    prompt: "",
    inputItems: [{ type: "image", url: "https://example.com/img.png" }],
  });
  assert.equal(withImage.length, 1);
  assert.equal(withImage[0].type, "image");

  assert.throws(() =>
    normalizeTurnInputItems({
      prompt: "",
      inputItems: [],
    }),
  );
});

test("toRequestId and toRpcId normalize ids", () => {
  assert.equal(toRequestId(42), 42);
  assert.equal(toRequestId("17"), 17);
  assert.equal(toRequestId("bad"), null);

  assert.equal(toRpcId(7), 7);
  assert.equal(toRpcId("req-1"), "req-1");
  assert.equal(toRpcId(""), null);
});

test("annotateSpawnError adds actionable guidance for known spawn failures", () => {
  const enoent = new Error("spawn failed");
  enoent.code = "ENOENT";
  assert.match(annotateSpawnError(enoent, "codex").message, /Cannot execute Codex binary/);

  const unknown = annotateSpawnError("boom", "codex");
  assert.match(unknown.message, /Unknown spawn error|boom/);
});
