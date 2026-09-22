import os from "node:os";
import path from "node:path";
import type { Env } from "../shared/daemon-url.ts";

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
