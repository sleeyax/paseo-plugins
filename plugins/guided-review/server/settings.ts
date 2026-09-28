import type { PluginSettings } from "@getpaseo/plugin/server";
import {
  configuredGhPath,
  configuredGuideAgent,
  DEFAULT_GH_PATH,
  DEFAULT_GUIDE_AGENT,
  type settingsDocument,
} from "../shared/settings.ts";

/** The handle `registerSettings` returns for this plugin's one document. */
export type Settings = PluginSettings<typeof settingsDocument.schema>;

/** Read at every call, since a save can change it; an invalid document counts as nothing configured. */
export async function readGhPath(settings: Pick<Settings, "read">): Promise<string> {
  const state = await settings.read();
  return state.status === "ready" ? configuredGhPath(state.values.ghPath) : DEFAULT_GH_PATH;
}

/** Read at every guide agent creation, like the gh path. */
export async function readGuideAgent(settings: Pick<Settings, "read">): Promise<string> {
  const state = await settings.read();
  return state.status === "ready" ? configuredGuideAgent(state.values.guideAgent) : DEFAULT_GUIDE_AGENT;
}
