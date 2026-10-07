import type { PluginSettings } from "@getpaseo/plugin/server";
import {
  configuredGhPath,
  configuredGlabPath,
  configuredGuideAgent,
  DEFAULT_GH_PATH,
  DEFAULT_GLAB_PATH,
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

export async function readGlabPath(settings: Pick<Settings, "read">): Promise<string> {
  const state = await settings.read();
  return state.status === "ready" ? configuredGlabPath(state.values.glabPath) : DEFAULT_GLAB_PATH;
}

/** The guide agent as configured: a provider or provider/model, and an effort and mode that are blank when left to it. */
export type GuideAgentSettings = { agent: string; effort: string; mode: string };

/** Read at every guide agent creation, like the gh path. */
export async function readGuideAgent(settings: Pick<Settings, "read">): Promise<GuideAgentSettings> {
  const state = await settings.read();
  if (state.status !== "ready") return { agent: DEFAULT_GUIDE_AGENT, effort: "", mode: "" };
  return {
    agent: configuredGuideAgent(state.values.guideAgent),
    effort: state.values.guideAgentEffort.trim(),
    mode: state.values.guideAgentMode.trim(),
  };
}
