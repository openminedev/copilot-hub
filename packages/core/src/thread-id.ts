const THREAD_ID_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;

export function normalizeThreadId(rawValue: unknown): string {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new Error("threadId is required.");
  }
  if (!THREAD_ID_PATTERN.test(value)) {
    throw new Error("Invalid threadId. Allowed chars: letters, digits, :, _, - (max 120).");
  }
  return value;
}
