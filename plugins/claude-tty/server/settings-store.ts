import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Env, settingsFilePath } from "./paths.ts";
import { type ClaudeTtySettings, type StoredState, coerceSettings } from "../shared/settings.ts";

/**
 * The daemon config drops keys it does not know, so the setting lives in the plugin's own cache file.
 * The adapter reads the same file when it schedules a suspension, which is what lets a change here
 * reach a session that is already connected.
 */
export async function readSettings(env: Env = process.env): Promise<ClaudeTtySettings> {
  try {
    return coerceSettings(JSON.parse(await readFile(settingsFilePath(env), "utf8")));
  } catch {
    return coerceSettings(null);
  }
}

export async function writeSettings(settings: ClaudeTtySettings, env: Env = process.env): Promise<ClaudeTtySettings> {
  const coerced = coerceSettings(settings);
  const target = settingsFilePath(env);
  const state: StoredState = { version: 1, settings: coerced };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return coerced;
}
