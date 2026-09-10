/** Discord drops clients that update their activity too often, and agent streams are far chattier than it allows. */
export const MIN_WRITE_INTERVAL_MS = 5_000;

export type WriteDecision =
  | { send: true }
  | { send: false; retryInMs: number | null };

export function decideWrite(input: {
  payload: string | null;
  lastPayload: string | null;
  lastSentAt: number | null;
  now: number;
  minIntervalMs?: number;
}): WriteDecision {
  const minIntervalMs = input.minIntervalMs ?? MIN_WRITE_INTERVAL_MS;
  if (input.payload === input.lastPayload) return { send: false, retryInMs: null };
  if (input.lastSentAt === null) return { send: true };
  const waited = input.now - input.lastSentAt;
  if (waited >= minIntervalMs) return { send: true };
  return { send: false, retryInMs: minIntervalMs - waited };
}
