import { stat } from "node:fs/promises";

/** How often the directory the adapter was started in is checked for having gone. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * A directory has to be missing this many checks in a row before the adapter gives up on it, so a
 * workspace being replaced rather than removed — deleted and recreated at the same path, which is
 * what reusing one looks like on disk — is not read as the end of the session.
 */
const MISSES_BEFORE_STOPPING = 2;

/**
 * Watches the directory the adapter runs in. Paseo archives a workspace by deleting it, and an
 * adapter left behind by that can do nothing for anyone: its Claude process cannot be started in a
 * directory that is gone, and nothing closes the adapter itself, so it holds its memory until the
 * machine is rebooted. Only a missing directory counts — one that cannot be read for any other
 * reason is still there, and a session is never stopped over a failure to look.
 */
export function watchWorkingDirectory(
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
