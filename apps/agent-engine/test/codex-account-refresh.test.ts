import assert from "node:assert/strict";
import test from "node:test";
let refreshHelpersPromise: Promise<any> | null = null;

async function loadRefreshHelpers() {
  if (!refreshHelpersPromise) {
    const specifier = ["..", "codex-account-refresh.js"].join("/");
    refreshHelpersPromise = import(specifier);
  }
  return refreshHelpersPromise;
}

test("collectRunningBotIds keeps only running bots with ids", async () => {
  const { collectRunningBotIds } = await loadRefreshHelpers();
  const botIds = collectRunningBotIds([
    { id: "agent-a", running: true },
    { id: "agent-b", running: false },
    { id: "agent-c", running: true },
    { running: true },
    null,
  ]);

  assert.deepEqual(botIds, ["agent-a", "agent-c"]);
});

test("refreshRunningBotProviders refreshes running bots and collects failures", async () => {
  const { refreshRunningBotProviders } = await loadRefreshHelpers();
  const refreshed: string[] = [];

  const result = await refreshRunningBotProviders({
    botManager: {
      async listBotsLive() {
        return [
          { id: "agent-a", running: true },
          { id: "agent-b", running: false },
          { id: "agent-c", running: true },
        ];
      },
      async refreshBotProviderSession(botId: string) {
        if (botId === "agent-c") {
          throw new Error("refresh failed");
        }
        refreshed.push(botId);
      },
    },
    reason: "codex account switched",
  });

  assert.deepEqual(refreshed, ["agent-a"]);
  assert.deepEqual(result.refreshedBotIds, ["agent-a"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.botId, "agent-c");
  assert.match(result.failures[0]?.error ?? "", /refresh failed/);
});
