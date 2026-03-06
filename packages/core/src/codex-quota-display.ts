type QuotaWindowLike = {
  remainingPercent?: unknown;
  resetsAt?: unknown;
} | null;

type QuotaSnapshotLike = {
  model?: unknown;
  primary?: QuotaWindowLike;
  secondary?: QuotaWindowLike;
} | null;

export function hasCodexQuotaWindows(snapshot: QuotaSnapshotLike): boolean {
  const primaryRemaining = Number(snapshot?.primary?.remainingPercent);
  const secondaryRemaining = Number(snapshot?.secondary?.remainingPercent);
  return Number.isFinite(primaryRemaining) || Number.isFinite(secondaryRemaining);
}

export function formatCodexQuotaLine(snapshot: QuotaSnapshotLike): string {
  const model = String(snapshot?.model ?? "").trim();
  const windows = [
    formatQuotaWindow("5h", snapshot?.primary ?? null),
    formatQuotaWindow("weekly", snapshot?.secondary ?? null),
  ].filter(Boolean);
  if (windows.length === 0 && !model) {
    return "";
  }

  if (windows.length === 0) {
    return `Codex model: ${model}`;
  }

  if (model) {
    return `Codex quota (${model}): ${windows.join(" | ")}`;
  }

  return `Codex quota: ${windows.join(" | ")}`;
}

function formatQuotaWindow(label: string, windowSnapshot: QuotaWindowLike): string {
  const remaining = Number(windowSnapshot?.remainingPercent);
  if (!Number.isFinite(remaining)) {
    return "";
  }

  const resetAt = Number(windowSnapshot?.resetsAt);
  const resetLabel = Number.isFinite(resetAt) ? `, reset ${formatEpochSeconds(resetAt)}` : "";
  return `${label} ${Math.round(clampPercent(remaining))}%${resetLabel}`;
}

function formatEpochSeconds(value: number): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }

  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return date.toISOString().replace(".000Z", "Z");
}

function clampPercent(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return n;
}
