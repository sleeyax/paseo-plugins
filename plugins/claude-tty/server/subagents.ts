import { subagentsDirectory } from "./paths.ts";
import { findSessionEntry } from "./sessions.ts";
import { isSafeStateFileStem } from "../shared/sessions.ts";
import { BackgroundCommandOutput, type BackgroundCommand } from "./background-commands.ts";
import { readSidecars, SubagentTranscript } from "./subagent-transcripts.ts";
import type { SubagentSource } from "./subsessions.ts";

/**
 * Where Claude keeps a session's subagents, on the disk the adapter writes to. The session the
 * daemon knows is the adapter's ACP session; which Claude session that is running on is recorded in
 * the adapter's state file and nowhere else, and it moves when the session compacts.
 */
export function subagentSource(backgroundCommand: (sessionId: string, callId: string) => BackgroundCommand | null): SubagentSource {
  return {
    async locate(nativeSessionId: string, cwd: string) {
      if (!isSafeStateFileStem(nativeSessionId)) return null;
      const entry = await findSessionEntry(nativeSessionId);
      const claudeSessionId = entry?.claudeSessionId ?? null;
      if (claudeSessionId === null || !isSafeStateFileStem(claudeSessionId)) return null;
      return subagentsDirectory(entry?.cwd ?? cwd, claudeSessionId);
    },
    list: (directory) => readSidecars(directory),
    open: (directory, agentId) => new SubagentTranscript(directory, agentId),
    backgroundCommand,
    openCommand: (command) => new BackgroundCommandOutput(command),
  };
}
