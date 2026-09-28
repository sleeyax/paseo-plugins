import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GuidePanel } from "./client/panel.tsx";
import { GuidedReviewSettings } from "./client/settings.tsx";
import { createStartSurface } from "./client/start.tsx";
import { PANEL_ID, PLUGIN_ICON, PLUGIN_ID, PLUGIN_LABEL, SETTINGS_SCREEN_ID, START_SURFACE_ID } from "./shared/identity.ts";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: PANEL_ID,
    title: PLUGIN_LABEL,
    icon: PLUGIN_ICON,
    context: "workspace",
    Component: GuidePanel,
  });

  client.addSurface(
    START_SURFACE_ID,
    createStartSurface((workspaceId) => client.openPanel(PANEL_ID, { workspaceId })),
  );

  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: PLUGIN_LABEL,
    icon: PLUGIN_ICON,
    Component: GuidedReviewSettings,
  });

  client.addCommandCenterItem({
    id: `${PLUGIN_ID}-start`,
    title: `${PLUGIN_LABEL}: start from a pull request URL`,
    icon: PLUGIN_ICON,
    keywords: ["review", "guide", "pull request", "pr", "github", "url"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(START_SURFACE_ID);
    },
  });

  return () => {};
}
