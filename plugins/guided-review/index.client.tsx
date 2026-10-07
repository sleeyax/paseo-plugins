import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import React from "react";
import { openPanelWhenReady } from "./client/open-panel.ts";
import { GuidePanel } from "./client/panel.tsx";
import { keepReviewButtons } from "./client/review-buttons.ts";
import { GuidedReviewSettings } from "./client/settings.tsx";
import { createStartScreen } from "./client/start.tsx";
import * as contracts from "./shared/contracts.ts";
import { PANEL_ID, PLUGIN_ICON, PLUGIN_ID, PLUGIN_LABEL, SETTINGS_SCREEN_ID, START_SCREEN_ID } from "./shared/identity.ts";

function StartSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={PLUGIN_ICON}
      active={currentScreen?.screenId === START_SCREEN_ID}
      onPress={() => openScreen({ screenId: START_SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const openPanel = (workspaceId: string) => client.openPanel(PANEL_ID, { workspaceId });

  client.addWorkspacePanel({
    id: PANEL_ID,
    title: PLUGIN_LABEL,
    icon: PLUGIN_ICON,
    context: "workspace",
    Component: (props) => <GuidePanel {...props} openPanel={(workspaceId) => void openPanelWhenReady(() => openPanel(workspaceId))} />,
  });

  client.addScreen({ id: START_SCREEN_ID, title: PLUGIN_LABEL, Component: createStartScreen(openPanel) });
  client.addSidebarHeaderItem({ id: START_SCREEN_ID, title: PLUGIN_LABEL, Component: StartSidebarItem });

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

  return keepReviewButtons(client, openPanel);
}
