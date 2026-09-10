/**
 * These three are mirrored by `apps/claude-tty-acp/src/idle-timeout.ts`, which reads the settings
 * file this plugin writes; the adapter is bundled from its own package and cannot import them.
 * Keep the two copies in step: a `MAX_IDLE_TIMEOUT_MS` that drifts lets this side save a value the
 * adapter then refuses.
 */
export const IDLE_TIMEOUT_ENV = "CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS";
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
export const MAX_IDLE_TIMEOUT_MS = 2_147_483_647;

export const IDLE_TIMEOUT_OPTIONS = [
  { value: 15 * 60 * 1_000, label: "15 minutes" },
  { value: 30 * 60 * 1_000, label: "30 minutes" },
  { value: DEFAULT_IDLE_TIMEOUT_MS, label: "1 hour" },
  { value: 2 * 60 * 60 * 1_000, label: "2 hours" },
  { value: 4 * 60 * 60 * 1_000, label: "4 hours" },
  { value: 8 * 60 * 60 * 1_000, label: "8 hours" },
  { value: 0, label: "Never" },
] as const;

export type ClaudeTtySettings = {
  /** Zero keeps every native Claude process alive until its session closes. */
  idleTimeoutMs: number;
};

export type StoredState = {
  version: 1;
  settings: ClaudeTtySettings;
};

/** Decimal integers only, matching the adapter: `Number` would also take `0x1c` and `1e3`. */
export function parseIdleTimeout(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_IDLE_TIMEOUT_MS ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= MAX_IDLE_TIMEOUT_MS ? value : null;
}

/** Anything unreadable reads as the default, which is what the adapter falls back to for the same file. */
export function coerceSettings(raw: unknown): ClaudeTtySettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS };
  const settings = (raw as { settings?: unknown }).settings ?? raw;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS };
  return { idleTimeoutMs: parseIdleTimeout((settings as Record<string, unknown>).idleTimeoutMs) ?? DEFAULT_IDLE_TIMEOUT_MS };
}
