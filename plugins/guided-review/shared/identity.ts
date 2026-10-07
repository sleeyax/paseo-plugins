/** Every ID the host sees is derived from this one, which is also the manifest's. */
export const PLUGIN_ID = "guided-review";
export const PLUGIN_LABEL = "Guided Review";
export const PLUGIN_ICON = "BookOpenCheck";

/** The workspace panel a guide is read in; one tab per workspace, so one guide per workspace. */
export const PANEL_ID = PLUGIN_ID;
/** Where a PR or MR URL is pasted; the sidebar item opens it. It keeps the ID the sidebar item had before it opened a screen, so saved links to it still resolve. */
export const START_SCREEN_ID = "start";
export const SETTINGS_SCREEN_ID = "settings";
