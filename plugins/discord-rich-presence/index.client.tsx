import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DiscordPresenceSurface } from "./client/settings.tsx";
import { setProjectLevel, updateSettings } from "./client/settings-writes.ts";

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
      await updateSettings(rpc, (settings) => ({ ...settings, enabled: false }));
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-on",
    title: "Discord rich presence: turn on",
    icon: "Eye",
    keywords: ["discord", "presence", "status"],
    context: "global",
    async onSelect({ rpc }) {
      await updateSettings(rpc, (settings) => ({ ...settings, enabled: true }));
    },
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-detailed",
    title: "Discord rich presence: show this project as Detailed",
    icon: "Eye",
    keywords: ["discord", "presence", "project", "detail", "privacy"],
    context: "workspace",
    onSelect: ({ rpc, workspace }) => setProjectLevel(rpc, workspace, "detailed"),
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-projects",
    title: "Discord rich presence: show this project as Projects only",
    icon: "Folder",
    keywords: ["discord", "presence", "project", "detail", "privacy"],
    context: "workspace",
    onSelect: ({ rpc, workspace }) => setProjectLevel(rpc, workspace, "projects"),
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-hidden",
    title: "Discord rich presence: show this project as Hidden",
    icon: "EyeOff",
    keywords: ["discord", "presence", "project", "hide", "privacy"],
    context: "workspace",
    onSelect: ({ rpc, workspace }) => setProjectLevel(rpc, workspace, "hidden"),
  });

  client.addCommandCenterItem({
    id: "discord-rich-presence-project-default",
    title: "Discord rich presence: show this project at the default level",
    icon: "Settings2",
    keywords: ["discord", "presence", "project", "default", "detail"],
    context: "workspace",
    onSelect: ({ rpc, workspace }) => setProjectLevel(rpc, workspace, null),
  });

  return () => {};
}
