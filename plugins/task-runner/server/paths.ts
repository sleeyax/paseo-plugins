import os from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "../shared/identity.ts";

/** The SDK gives a plugin no directory of its own, so this mirrors the daemon's `PASEO_HOME`, which the plugin process inherits. */
export function dataDirectory(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PASEO_HOME?.trim() || "~/.paseo";
  const home = env.HOME || os.homedir();
  const paseoHome = configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;
  return path.join(path.resolve(paseoHome), "plugin-data", PLUGIN_ID);
}
