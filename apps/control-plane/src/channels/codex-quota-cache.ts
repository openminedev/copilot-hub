let cachedCodexUsage: { expiresAt: number; snapshot: unknown } | null = null;

export function readCachedCodexQuotaSnapshot(now: number): unknown | null {
  if (cachedCodexUsage && now < cachedCodexUsage.expiresAt) {
    return cachedCodexUsage.snapshot;
  }
  return null;
}

export function writeCachedCodexQuotaSnapshot(snapshot: unknown, expiresAt: number): void {
  cachedCodexUsage = {
    expiresAt,
    snapshot,
  };
}

export function invalidateCodexQuotaUsageCache(): void {
  cachedCodexUsage = null;
}
