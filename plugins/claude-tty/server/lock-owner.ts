import { ADAPTER_BINARY_NAME, ADAPTER_ENTRY_NAME } from "./paths.ts";
import type { SessionLock } from "../shared/sessions.ts";

/**
 * The adapter runs as `node <checkout>/apps/claude-tty-acp/<...>/cli.js`. Matching that as one path
 * rather than as two substrings anywhere in the line is what keeps the `claude` child out: it is
 * handed a `--settings` path carrying the adapter's name, and is itself `node <...>/cli.js` wherever
 * Claude Code is installed as a bundle rather than as a binary.
 *
 * Built from the names the plugin registers the adapter under, so renaming either cannot leave a
 * guard behind that still matches the old one.
 */
const ADAPTER_COMMAND = new RegExp(
  `(?:^|/)${quote(ADAPTER_BINARY_NAME)}/\\S*/${quote(ADAPTER_ENTRY_NAME)}(?:\\s|$)`,
);

function quote(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How far a process may appear to have started after its own lock before it reads as a different
 * process. `ps` truncates to the second and a boot-time reading drifts against the wall clock, so
 * the comparison needs slack; PIDs take far longer than this to come round again.
 */
const START_SLACK_MS = 5_000;

/** What a stop has to know about the process a lock names before it will signal it. */
export type ProcessIdentity = {
  command: string;
  /** Epoch ms the process started, or null on a host that would not say. */
  startedAt: number | null;
  /** Already exited and waiting to be reaped, which no signal can help. */
  zombie: boolean;
};

export function isAdapterCommand(command: string): boolean {
  return ADAPTER_COMMAND.test(command);
}

/** Why a process may not be signalled on a lock's behalf, phrased so a caller can say which it was. */
export type LockOwnerRefusal = "zombie" | "not-adapter" | "unknown-start" | "started-after-lock";

/**
 * A PID outlives the process that earned it, so the owner of a lock is identified rather than
 * assumed. Two live processes cannot share a PID, so a process that was already running when the
 * lock was written and still holds that PID is the process that wrote it — which is what makes the
 * start time worth more than the command line, and what keeps a *second* adapter that inherited the
 * PID from being mistaken for this one.
 *
 * A host that will not give a start time is its own answer: the check cannot be made, which is not
 * the same as making it and finding a stranger.
 */
export function lockOwnerRefusal(identity: ProcessIdentity, lock: SessionLock): LockOwnerRefusal | null {
  if (identity.zombie) return "zombie";
  if (!isAdapterCommand(identity.command)) return "not-adapter";
  if (identity.startedAt === null) return "unknown-start";
  return identity.startedAt <= lock.createdAt + START_SLACK_MS ? null : "started-after-lock";
}

export function ownsLock(identity: ProcessIdentity, lock: SessionLock): boolean {
  return lockOwnerRefusal(identity, lock) === null;
}
