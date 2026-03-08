type RefreshFailure = {
  botId: string;
  error: string;
};

type BotManagerLike = {
  listBotsLive: () => Promise<unknown[]>;
  refreshBotProviderSession: (botId: string, reason?: string) => Promise<unknown>;
};

export async function refreshRunningBotProviders({
  botManager,
  reason = "codex account switched",
}: {
  botManager: BotManagerLike;
  reason?: string;
}): Promise<{
  refreshedBotIds: string[];
  failures: RefreshFailure[];
}> {
  const statuses = await botManager.listBotsLive();
  const runningBotIds = collectRunningBotIds(statuses);
  const refreshedBotIds: string[] = [];
  const failures: RefreshFailure[] = [];

  for (const botId of runningBotIds) {
    try {
      await botManager.refreshBotProviderSession(botId, reason);
      refreshedBotIds.push(botId);
    } catch (error) {
      failures.push({
        botId,
        error: sanitizeError(error),
      });
    }
  }

  return {
    refreshedBotIds,
    failures,
  };
}

export function collectRunningBotIds(statuses: unknown): string[] {
  const runningBotIds: string[] = [];

  for (const entry of Array.isArray(statuses) ? statuses : []) {
    if (!isRecord(entry) || entry.running !== true) {
      continue;
    }

    const botId = String(entry.id ?? "").trim();
    if (botId) {
      runningBotIds.push(botId);
    }
  }

  return runningBotIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
