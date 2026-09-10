import { promises as fs } from "node:fs";
import path from "node:path";
import type { Env } from "../shared/daemon-url.ts";
import type { PresenceSettings } from "../shared/presence.ts";
import { coerceSettings, type StoredState } from "../shared/settings.ts";
import { settingsFilePath } from "./paths.ts";

export class SettingsStore {
  private settings: PresenceSettings | null = null;
  private readonly env: Env;

  constructor(env: Env = process.env) {
    this.env = env;
  }

  async read(): Promise<PresenceSettings> {
    if (this.settings) return this.settings;
    let raw: unknown = null;
    try {
      raw = JSON.parse(await fs.readFile(settingsFilePath(this.env), "utf8"));
    } catch {
      raw = null;
    }
    this.settings = coerceSettings(raw);
    return this.settings;
  }

  async write(settings: PresenceSettings): Promise<PresenceSettings> {
    const coerced = coerceSettings(settings);
    this.settings = coerced;
    const target = settingsFilePath(this.env);
    const state: StoredState = { version: 1, settings: coerced };
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return coerced;
  }
}
