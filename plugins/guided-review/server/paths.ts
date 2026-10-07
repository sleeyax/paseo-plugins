import os from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "../shared/identity.ts";

export type Env = Record<string, string | undefined>;

/** Mirrors the daemon's own `resolvePaseoHome`, whose `PASEO_HOME` the plugin process inherits. */
export function paseoHome(env: Env = process.env): string {
  const home = env.PASEO_HOME?.trim() || "~/.paseo";
  return path.resolve(expandHome(home, env));
}

/**
 * Everything this plugin keeps: reviews and the clones it made. The SDK gives a plugin no directory
 * of its own, so it lives beside the daemon's settings store in the Paseo home, one per daemon,
 * because the workspace IDs it records mean something only to that daemon.
 */
export function dataDirectory(env: Env = process.env): string {
  return path.join(paseoHome(env), "plugin-data", PLUGIN_ID);
}

function expandHome(input: string, env: Env): string {
  const home = env.HOME || os.homedir();
  if (input === "~") return home;
  return input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
}
