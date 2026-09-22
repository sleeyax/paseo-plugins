import type { PluginSettings } from "@getpaseo/plugin/server";
import { configuredAdapterExecutable, type settingsDocument } from "../shared/settings.ts";

/** The handle `registerSettings` returns for this plugin's one document. */
export type Settings = PluginSettings<typeof settingsDocument.schema>;

/**
 * An invalid document is a host that has configured nothing: refusing to run an adapter over it
 * would take every session down, and the settings screen already says the document is invalid.
 */
export async function readConfiguredExecutable(settings: Pick<Settings, "read">): Promise<string | null> {
  const state = await settings.read();
  return state.status === "ready" ? configuredAdapterExecutable(state.values.adapterExecutable) : null;
}
