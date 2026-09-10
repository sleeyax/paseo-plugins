export const SESSION_SUFFIX = ".json";
export const LOCK_SUFFIX = ".lock";

/** A file read out of the state directory, or its name alone when reading it failed. */
export type StateFile = { name: string; contents: string | null };

export type SessionLock = { pid: number; createdAt: number; live: boolean };

/** The Paseo agent this session is the ACP half of, which is what the panel names it by. */
export type SessionAgent = { id: string; title: string | null };

export type SessionEntry = {
  id: string;
  claudeSessionId: string | null;
  cwd: string | null;
  model: string | null;
  mode: string | null;
  lastActivity: number | null;
  /** The session file exists but says nothing the adapter could resume from. */
  corrupt: boolean;
  /** A session file the adapter never wrote, seen only through the lock left behind. */
  orphanLock: boolean;
  lock: SessionLock | null;
  agent: SessionAgent | null;
};

/**
 * The state directory is two flat directories keyed by ACP session ID, so the join is on the file
 * stem. A lock with no session beside it is still worth listing: releasing it is the whole point.
 */
export function joinSessions(
  sessions: readonly StateFile[],
  locks: readonly StateFile[],
  isAlive: (pid: number) => boolean,
): SessionEntry[] {
  const lockById = new Map<string, SessionLock>();
  for (const file of locks) {
    if (!file.name.endsWith(LOCK_SUFFIX)) continue;
    const record = parseLock(file.contents);
    lockById.set(file.name.slice(0, -LOCK_SUFFIX.length), {
      pid: record?.pid ?? -1,
      createdAt: record?.createdAt ?? 0,
      live: record === null ? false : isAlive(record.pid),
    });
  }

  const entries: SessionEntry[] = [];
  for (const file of sessions) {
    if (!file.name.endsWith(SESSION_SUFFIX)) continue;
    const id = file.name.slice(0, -SESSION_SUFFIX.length);
    const session = parseSession(file.contents);
    const lock = lockById.get(id) ?? null;
    lockById.delete(id);
    entries.push({
      id,
      claudeSessionId: session?.claudeSessionId ?? null,
      cwd: session?.cwd ?? null,
      model: session?.model ?? null,
      mode: session?.mode ?? null,
      lastActivity: session?.lastActivity ?? null,
      corrupt: session === null,
      orphanLock: false,
      lock,
      agent: null,
    });
  }

  for (const [id, lock] of lockById) {
    entries.push({
      id,
      claudeSessionId: null,
      cwd: null,
      model: null,
      mode: null,
      lastActivity: null,
      corrupt: false,
      orphanLock: true,
      lock,
      agent: null,
    });
  }

  return entries.sort(byRecency);
}

/** Live sessions first, then the most recently used, then something stable. */
function byRecency(a: SessionEntry, b: SessionEntry): number {
  if ((a.lock?.live ?? false) !== (b.lock?.live ?? false)) return a.lock?.live ? -1 : 1;
  if (a.lastActivity !== b.lastActivity) return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
  return a.id.localeCompare(b.id);
}


type ParsedSession = { claudeSessionId: string; cwd: string; model: string; mode: string; lastActivity: number };

function parseSession(contents: string | null): ParsedSession | null {
  const record = parseObject(contents);
  if (record === null) return null;
  if (
    typeof record.claudeSessionId !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.model !== "string" ||
    typeof record.mode !== "string" ||
    typeof record.lastActivity !== "number"
  ) {
    return null;
  }
  return {
    claudeSessionId: record.claudeSessionId,
    cwd: record.cwd,
    model: record.model,
    mode: record.mode,
    lastActivity: record.lastActivity,
  };
}

function parseLock(contents: string | null): { pid: number; createdAt: number } | null {
  const record = parseObject(contents);
  if (record === null || typeof record.pid !== "number" || typeof record.createdAt !== "number") return null;
  return { pid: record.pid, createdAt: record.createdAt };
}

function parseObject(contents: string | null): Record<string, unknown> | null {
  if (contents === null) return null;
  try {
    return asRecord(JSON.parse(contents));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Paseo keys an ACP agent by the session ID the adapter handed it, which is this file stem, so the
 * two lists join on it. The daemon answers with `{ agent, project }` entries; a bare agent is read
 * too, as tolerance rather than because anything hands one over.
 */
export function attachAgents(entries: readonly SessionEntry[], agents: readonly unknown[]): SessionEntry[] {
  const bySessionId = new Map<string, SessionAgent>();
  for (const candidate of agents) {
    const agent = readAgent(candidate);
    if (agent !== null) bySessionId.set(agent.sessionId, agent.agent);
  }
  return entries.map((entry) => ({ ...entry, agent: bySessionId.get(entry.id) ?? null }));
}

function readAgent(candidate: unknown): { sessionId: string; agent: SessionAgent } | null {
  const outer = asRecord(candidate);
  if (outer === null) return null;
  const record = asRecord(outer.agent) ?? outer;
  const sessionId = asRecord(record.runtimeInfo)?.sessionId ?? asRecord(record.persistence)?.sessionId;
  if (typeof record.id !== "string" || typeof sessionId !== "string") return null;
  return {
    sessionId,
    agent: {
      id: record.id,
      title: typeof record.title === "string" && record.title !== "" ? record.title : null,
    },
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a session has been left alone, which is what decides whether it is worth stopping. The
 * adapter stamps `lastActivity` when it saves a session, which it does as a prompt *starts*, so this
 * says "last prompted" rather than "active": a session an hour into one turn is still working. Both
 * sides read the daemon's clock, and one that has moved backwards reads as the present.
 */
export function lastActiveLabel(lastActivity: number | null, now: number): string | null {
  if (lastActivity === null || !Number.isFinite(lastActivity)) return null;
  const elapsed = now - lastActivity;
  if (elapsed < MINUTE_MS) return "last prompted just now";
  if (elapsed < HOUR_MS) return `last prompted ${count(elapsed / MINUTE_MS, "minute")} ago`;
  if (elapsed < DAY_MS) return `last prompted ${count(elapsed / HOUR_MS, "hour")} ago`;
  return `last prompted ${count(elapsed / DAY_MS, "day")} ago`;
}

function count(units: number, unit: string): string {
  const whole = Math.floor(units);
  return `${whole} ${unit}${whole === 1 ? "" : "s"}`;
}

/** Guards a name coming back from the client before it is joined onto the state directory. */
export function isSafeStateFileStem(stem: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem) && !stem.includes("..");
}
