import { readFile } from "node:fs/promises";
import { writeLog } from "./log.ts";

let settingsFile: string | null = null;

/**
 * Paseo's Claude TTY plugin keeps a resolved copy of its settings for this adapter and passes the
 * path at spawn, rewriting the file whenever someone changes a setting. An adapter run outside Paseo
 * is given none and has only its environment.
 */
export function useSettingsFile(filePath: string | null): void {
  settingsFile = filePath;
}

export function currentSettingsFile(): string | null {
  return settingsFile;
}

/**
 * The plugin writes `{ idleTimeoutMs, autoAccept, bypassAutoAccept }`, every choice already resolved,
 * with a null `bypassAutoAccept` meaning Bypass Permissions follows `autoAccept`. Each reader takes the
 * field it knows and judges it itself, so one it cannot use falls back on its own. Null is a file there
 * is nothing to read from.
 */
export async function readSettingsValues(filePath: string | null = settingsFile): Promise<Record<string, unknown> | null> {
  if (filePath === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    // No file is the normal state outside Paseo.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      writeLog({ level: "warn", message: "Ignored an unreadable Claude TTY settings document", file: filePath, error: errorMessage(error) });
    }
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
