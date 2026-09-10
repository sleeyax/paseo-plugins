import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as contracts from "./shared/contracts.ts";
import { DiscordPresenceSurface } from "./client/settings.tsx";

export const SURFACE_ID = "settings";

export default function contribute(client: PluginClientContext) {
  client.addSurface(SURFACE_ID, DiscordPresenceSurface);

  client.addSidebarItem({
    id: "discord-rich-presence",
    title: "Discord",
    icon: "Gamepad2",
    surface: SURFACE_ID,
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-off",
    title: "Discord rich presence: turn off",
    icon: "EyeOff",
    keywords: ["discord", "presence", "status", "privacy"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(contracts.setEnabled, { enabled: false });
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-on",
    title: "Discord rich presence: turn on",
    icon: "Eye",
    keywords: ["discord", "presence", "status"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(contracts.setEnabled, { enabled: true });
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-detailed",
    title: "Discord rich presence: show this project as Detailed",
    icon: "Eye",
    keywords: ["discord", "presence", "project", "detail", "privacy"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(contracts.setProjectLevel, {
        rootPath: workspace.projectRootPath,
        displayName: workspace.projectDisplayName,
        level: "detailed",
      });
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-projects",
    title: "Discord rich presence: show this project as Projects only",
    icon: "Folder",
    keywords: ["discord", "presence", "project", "detail", "privacy"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(contracts.setProjectLevel, {
        rootPath: workspace.projectRootPath,
        displayName: workspace.projectDisplayName,
        level: "projects",
      });
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-hidden",
    title: "Discord rich presence: show this project as Hidden",
    icon: "EyeOff",
    keywords: ["discord", "presence", "project", "hide", "privacy"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(contracts.setProjectLevel, {
        rootPath: workspace.projectRootPath,
        displayName: workspace.projectDisplayName,
        level: "hidden",
      });
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-default",
    title: "Discord rich presence: show this project at the default level",
    icon: "Settings2",
    keywords: ["discord", "presence", "project", "default", "detail"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(contracts.setProjectLevel, {
        rootPath: workspace.projectRootPath,
        displayName: workspace.projectDisplayName,
        level: null,
      });
    },
  });

  return () => {};
}
