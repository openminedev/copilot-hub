import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexQuotaLine } from "../dist/codex-quota-display.js";

test("formatCodexQuotaLine returns empty when no model and no windows", () => {
  assert.equal(formatCodexQuotaLine(null), "");
  assert.equal(formatCodexQuotaLine({}), "");
});

test("formatCodexQuotaLine renders model-only status", () => {
  assert.equal(formatCodexQuotaLine({ model: "gpt-5" }), "Codex model: gpt-5");
});

test("formatCodexQuotaLine renders both windows and model", () => {
  const line = formatCodexQuotaLine({
    model: "gpt-5.3-codex",
    primary: { remainingPercent: 87.4, resetsAt: 1_900_000_000 },
    secondary: { remainingPercent: 52.1, resetsAt: 1_900_100_000 },
  });

  assert.match(line, /^Codex quota \(gpt-5\.3-codex\): 5h 87%, reset /);
  assert.match(line, /\| weekly 52%, reset /);
});
