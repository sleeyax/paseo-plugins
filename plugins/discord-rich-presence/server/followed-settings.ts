import type { PluginSettingsState } from "@getpaseo/plugin/server";
import type { PresenceSettings } from "../shared/presence.ts";
import type { settingsDocument } from "../shared/settings.ts";

export type SettingsState = PluginSettingsState<typeof settingsDocument.schema>;

/** An invalid document keeps the current settings, so a bad save never exposes a hidden project. */
export function followedSettings(current: PresenceSettings | null, state: SettingsState): PresenceSettings | null {
  return state.status === "ready" ? state.values : current;
}
