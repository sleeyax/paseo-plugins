import { stat } from "node:fs/promises";

/** How often a session's directory is checked for having gone. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * A directory has to be missing this many checks in a row before the adapter gives up on it, so a workspace being replaced rather than removed — deleted and recreated at the same path, which is what reusing one looks like on disk — is not read as the end of the session.
 */
const MISSES_BEFORE_STOPPING = 2;

/**
 * Watches the directory of every session this adapter holds and stops it once all of them have gone.
 * The daemon closes the connection when it archives or deletes an agent, which is what normally ends an adapter, and this is the backstop for one that close never reached.
 * A directory that is no longer there is the visible symptom: Paseo archives a workspace by deleting it, and an adapter left standing in one that has gone can do nothing for anyone — Claude cannot be started there — while it holds its memory until the machine is rebooted.
 */
export class WorkspaceWatchdog {
  private readonly onAllRemoved: () => void;
  private readonly intervalMs: number;
  private readonly watchers = new Map<string, () => void>();
  private readonly removed = new Set<string>();

  constructor(onAllRemoved: () => void, intervalMs = CHECK_INTERVAL_MS) {
    this.onAllRemoved = onAllRemoved;
    this.intervalMs = intervalMs;
  }

  /** Starts watching where a session works, which is the one directory the adapter is told about. */
  watch(sessionId: string, directory: string): void {
    if (this.watchers.has(sessionId)) return;
    const stop = watchDirectory(
      directory,
      () => {
        this.removed.add(sessionId);
        if (this.removed.size < this.watchers.size) return;
        this.stop();
        this.onAllRemoved();
      },
      this.intervalMs,
    );
    this.watchers.set(sessionId, stop);
  }

  stop(): void {
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    this.removed.clear();
  }
}

/**
 * Reports a directory that has stayed missing.
 * Only a missing directory counts — one that cannot be read for any other reason is still there, and a session is never stopped over a failure to look.
 */
export function watchDirectory(
  directory: string,
  onRemoved: () => void,
  intervalMs = CHECK_INTERVAL_MS,
  missesBeforeStopping = MISSES_BEFORE_STOPPING,
): () => void {
  let misses = 0;
  let stopped = false;
  const timer = setInterval(() => {
    void stat(directory).then(
      () => {
        misses = 0;
      },
      (error: unknown) => {
        if (!isMissing(error)) return;
        misses += 1;
        if (misses < missesBeforeStopping || stopped) return;
        stopped = true;
        clearInterval(timer);
        onRemoved();
      },
    );
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
