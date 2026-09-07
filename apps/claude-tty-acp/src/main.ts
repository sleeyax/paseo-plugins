import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { ClaudeTtyAgent } from "./agent.ts";
import { readIdleTimeout, settingsFilePath } from "./idle-timeout.ts";
import { enableLogFile, writeLog } from "./log.ts";
import { cleanupAbandonedRuntimeDirectories } from "./runtime-directories.ts";
import { watchWorkingDirectory } from "./workspace-watchdog.ts";

export async function runAcpServer(): Promise<void> {
  // The daemon reads stderr and keeps none of it, so the server also writes its log to disk.
  // A host that cannot hold the file has already said so on stderr, and still serves its sessions.
  const logFile = enableLogFile();
  if (logFile) writeLog({ level: "info", message: "Writing the adapter log to a file as well", file: logFile });
  await cleanupAbandonedRuntimeDirectories();
  // Only reported here; each suspension reads the value again so a change in Paseo reaches sessions that are already connected.
  writeLog({ level: "info", message: "Resolved the idle timeout", idleTimeoutMs: await readIdleTimeout(), settingsFile: settingsFilePath() });
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  let agent: ClaudeTtyAgent | null = null;
  const connection = new AgentSideConnection((activeConnection) => {
    agent = new ClaudeTtyAgent(activeConnection);
    return agent;
  }, ndJsonStream(output, input));

  const shutdown = async (signal: string): Promise<void> => {
    writeLog({ level: "info", message: "Stopping ACP adapter", signal });
    await agent?.close();
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).finally(() => process.exit(0));
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  // The daemon closes the connection when it is done with an adapter, which is what normally ends
  // this process. An archived workspace is the case it does not cover: the directory goes, the
  // connection stays open, and nothing else would ever stop the adapter standing in it.
  const workingDirectory = process.cwd();
  const stopWatchingWorkspace = watchWorkingDirectory(workingDirectory, () => {
    writeLog({ level: "warn", message: "Stopping the adapter: its working directory is gone", directory: workingDirectory });
    void shutdown("workspace_removed").finally(() => process.exit(0));
  });

  await connection.closed;
  stopWatchingWorkspace();
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  await shutdown("connection_closed");
}
