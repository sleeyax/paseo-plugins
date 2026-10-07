import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DiscordPresenceScreen } from "./client/settings.tsx";
import { setProjectLevel, updateSettings } from "./client/settings-writes.ts";

// The ID the sidebar item had before it opened a screen, so saved links to it still resolve.
export const SCREEN_ID = "discord-rich-presence";
const TITLE = "Discord";

function DiscordSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Gamepad2"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: TITLE, Component: DiscordPresenceScreen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: DiscordSidebarItem });

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
