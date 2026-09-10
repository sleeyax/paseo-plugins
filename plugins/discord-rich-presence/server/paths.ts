import os from "node:os";
import path from "node:path";
import type { Env } from "../shared/daemon-url.ts";

export function cacheDir(env: Env = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(env.HOME ?? os.homedir(), ".cache");
  return path.join(base, "paseo-plugins", "discord-rich-presence");
}

/** Plugin-owned persistence: the daemon config drops unknown keys, so settings live in the cache dir. */
export function settingsFilePath(env: Env = process.env): string {
  return path.join(cacheDir(env), "settings.json");
}

export function paseoHomeDir(env: Env = process.env): string {
  const configured = env.PASEO_HOME?.trim();
  if (configured) return configured;
  return path.join(env.HOME ?? os.homedir(), ".paseo");
}

export function pidFilePath(env: Env = process.env): string {
  return path.join(paseoHomeDir(env), "paseo.pid");
}

export function daemonConfigPath(env: Env = process.env): string {
  return path.join(paseoHomeDir(env), "config.json");
}
