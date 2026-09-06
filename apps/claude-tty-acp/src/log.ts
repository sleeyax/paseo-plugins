import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { APP_NAME } from "./constants.ts";
import { defaultStateDirectory } from "./state-store.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  level: LogLevel;
  message: string;
  [key: string]: unknown;
};

/**
 * One file is shared by every adapter process on the host, so a record carries its pid. When the
 * file reaches this size it is moved aside once, so the log holds the last two of these at most.
 */
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

let logFile: { path: string; maxBytes: number } | null = null;
let reportedFileFailure = false;

/** Mirrors the state store's directory, because the log is about the sessions kept there. */
export function logFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultStateDirectory(env), "logs", `${APP_NAME}.log`);
}

/**
 * Stderr is where the daemon reads the adapter's logs — and drops them, so nothing of what a
 * session did survives the moment anyone asks. The server keeps a copy on disk; the diagnose
 * command and the tests do not, since neither is a session anyone will need to reconstruct.
 */
export function enableLogFile(filePath = logFilePath(), maxBytes = MAX_LOG_FILE_BYTES): string {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  logFile = { path: filePath, maxBytes };
  reportedFileFailure = false;
  return filePath;
}

export function disableLogFile(): void {
  logFile = null;
}

export function writeLog(record: LogRecord): void {
  const line = `${JSON.stringify({ app: APP_NAME, time: new Date().toISOString(), pid: process.pid, ...record })}\n`;
  process.stderr.write(line);
  if (logFile) appendToLogFile(logFile, line);
}

function appendToLogFile(file: { path: string; maxBytes: number }, line: string): void {
  try {
    if (currentSize(file.path) >= file.maxBytes) renameSync(file.path, `${file.path}.1`);
    // Opened for every line rather than held open, so a process that goes on logging after another
    // has rotated the file lands in the new one instead of the one moved aside.
    appendFileSync(file.path, line, { mode: 0o600 });
  } catch (error) {
    // The file is a courtesy; losing it must never take a session down, and saying so once is enough.
    if (reportedFileFailure) return;
    reportedFileFailure = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ app: APP_NAME, time: new Date().toISOString(), pid: process.pid, level: "warn", message: "Could not write the adapter log file", file: file.path, error: message })}\n`);
  }
}

function currentSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
}
