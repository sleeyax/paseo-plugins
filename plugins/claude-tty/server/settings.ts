import type { PluginSettings } from "@getpaseo/plugin/server";
import { configuredAdapterExecutable, type settingsDocument } from "../shared/settings.ts";

/** The handle `registerSettings` returns for this plugin's one document. */
export type Settings = PluginSettings<typeof settingsDocument.schema>;

/** An invalid document counts as nothing configured, so a bad save can't take every session down. */
export async function readConfiguredExecutable(settings: Pick<Settings, "read">): Promise<string | null> {
  const state = await settings.read();
  return state.status === "ready" ? configuredAdapterExecutable(state.values.adapterExecutable) : null;
}
