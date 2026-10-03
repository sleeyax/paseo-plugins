import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GuidePanel } from "./client/panel.tsx";
import { GuidedReviewSettings } from "./client/settings.tsx";
import { createStartSurface } from "./client/start.tsx";
import * as contracts from "./shared/contracts.ts";
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

  client.addSidebarItem({
    id: START_SURFACE_ID,
    title: PLUGIN_LABEL,
    icon: PLUGIN_ICON,
    surface: START_SURFACE_ID,
  });

  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: PLUGIN_LABEL,
    icon: PLUGIN_ICON,
    Component: GuidedReviewSettings,
  });

  client.addCommandCenterItem({
    id: `${PLUGIN_ID}-guide-branch`,
    title: `${PLUGIN_LABEL}: guide this branch's PR/MR`,
    icon: PLUGIN_ICON,
    keywords: ["review", "guide", "branch", "pull request", "pr", "github", "merge request", "mr", "gitlab"],
    context: "workspace",
    async onSelect({ rpc, workspace, openPanel }) {
      // The item cannot show anything itself, so the panel follows the start: the PR/MR found, a
      // choice between several, or why the branch was left alone.
      try {
        await rpc(contracts.startBranchReview, { workspaceId: workspace.id, url: null });
      } finally {
        openPanel(PANEL_ID);
      }
    },
  });

  return () => {};
}
