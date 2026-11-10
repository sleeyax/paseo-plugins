import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TasksPanel } from "./client/tasks-panel.tsx";
import * as contracts from "./shared/contracts.ts";
import { PANEL_ICON, PANEL_ID, PANEL_TITLE } from "./shared/identity.ts";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: PANEL_TITLE,
    icon: PANEL_ICON,
    locations: ["explorer"],
    Component: TasksPanel,
  });

  const removeCommand = client.addCommandCenterItem({
    id: "run-task",
    title: "Run Task...",
    icon: PANEL_ICON,
    keywords: ["task", "script", "npm", "make", "nx", "run"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID, { location: "explorer" });
    },
  });

  const removeRerun = client.addCommandCenterItem({
    id: "rerun-last-task",
    title: "Rerun Last Task",
    icon: "RotateCw",
    keywords: ["task", "script", "rerun", "repeat", "again"],
    context: "workspace",
    async onSelect({ rpc, workspace, openPanel }) {
      // The panel shows the rerun's progress, or lets a first task be picked.
      try {
        await rpc(contracts.rerunLastTask, { workspaceId: workspace.id });
      } finally {
        openPanel(PANEL_ID, { location: "explorer" });
      }
    },
  });

  return () => {
    removePanel();
    removeCommand();
    removeRerun();
  };
}
