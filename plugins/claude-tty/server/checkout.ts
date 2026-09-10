import { access, constants } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { PLUGIN_ID, adapterManifestPath, repoRootFromPluginPath } from "./paths.ts";

export type RepoRoot = { root: string; problem: null } | { root: null; problem: string };

/**
 * The plugin manages the checkout it was itself installed from, which only the daemon config knows.
 * A bundled plugin has no reliable path of its own to walk up from.
 */
export async function resolveRepoRoot(paseo: PaseoApi): Promise<RepoRoot> {
  let entry: { path: string } | undefined;
  try {
    entry = (await paseo.config.get()).config.plugins?.[PLUGIN_ID];
  } catch (error) {
    return { root: null, problem: `Could not read the daemon configuration: ${messageOf(error)}` };
  }
  if (!entry) {
    return { root: null, problem: `The daemon configuration has no plugin entry for "${PLUGIN_ID}", so there is no checkout to manage.` };
  }
  const root = repoRootFromPluginPath(entry.path);
  const manifest = adapterManifestPath(root);
  if (!(await fileExists(manifest))) {
    return { root: null, problem: `${manifest} does not exist, so ${entry.path} is not a plugin directory inside a paseo-plugins checkout.` };
  }
  return { root, problem: null };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate the daemon could actually execute, which is what a spawn would pick. */
export async function firstExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
