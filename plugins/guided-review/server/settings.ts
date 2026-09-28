import type { PluginSettings } from "@getpaseo/plugin/server";
import { configuredGhPath, configuredGlabPath, DEFAULT_GH_PATH, DEFAULT_GLAB_PATH, type settingsDocument } from "../shared/settings.ts";

/** The handle `registerSettings` returns for this plugin's one document. */
export type Settings = PluginSettings<typeof settingsDocument.schema>;

/** Read at every call, since a save can change it; an invalid document counts as nothing configured. */
export async function readGhPath(settings: Pick<Settings, "read">): Promise<string> {
  const state = await settings.read();
  return state.status === "ready" ? configuredGhPath(state.values.ghPath) : DEFAULT_GH_PATH;
}

export async function readGlabPath(settings: Pick<Settings, "read">): Promise<string> {
  const state = await settings.read();
  return state.status === "ready" ? configuredGlabPath(state.values.glabPath) : DEFAULT_GLAB_PATH;
}
