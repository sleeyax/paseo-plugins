/** Every ID the host sees is derived from this one, which is also the manifest's. */
export const PLUGIN_ID = "guided-review";
export const PLUGIN_LABEL = "Guided Review";
export const PLUGIN_ICON = "BookOpenCheck";

/** The workspace panel a guide is read in; one tab per workspace, so one guide per workspace. */
export const PANEL_ID = PLUGIN_ID;
/** Where a PR URL is pasted, since a Command Center item cannot take text. */
export const START_SURFACE_ID = "start";
export const SETTINGS_SCREEN_ID = "settings";
