import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import * as contracts from "./shared/contracts.ts";
import { PLUGIN_ID, PLUGIN_LABEL } from "./shared/identity.ts";
import { ClaudeTtySettings } from "./client/settings.tsx";
import { ClaudeTtyScreen } from "./client/screen.tsx";

// Everything the app keys a contribution by is the plugin's own ID or built from it, so that a
// second copy installed beside this one claims none of the first one's: not its screen, not its
// settings screen, not its command-centre entries. ./shared/identity.ts is where it comes from.
// The screen's ID is also the one its sidebar item had before it opened a screen, so saved links to it still resolve.
export const SCREEN_ID = PLUGIN_ID;
export const SETTINGS_SCREEN_ID = PLUGIN_ID;

function ClaudeTtySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="SquareTerminal"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: PLUGIN_LABEL, Component: ClaudeTtyScreen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: PLUGIN_LABEL, Component: ClaudeTtySidebarItem });

  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: PLUGIN_LABEL,
    icon: "SquareTerminal",
    Component: ClaudeTtySettings,
  });

  // The panel cannot reach the settings screen: `openSettings` is on command contexts, never on a
  // screen's props. This is the affordance that does, alongside Settings → Plugins itself.
  client.addCommandCenterItem({
    id: `${PLUGIN_ID}-settings`,
    title: `${PLUGIN_LABEL}: settings`,
    icon: "Settings",
    keywords: ["claude", "adapter", "acp", "idle", "suspend", "timeout"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_SCREEN_ID);
    },
  });

  client.addCommandCenterItem({
    id: `${PLUGIN_ID}-doctor`,
    title: `${PLUGIN_LABEL}: run diagnostics`,
    icon: "Stethoscope",
    keywords: ["claude", "adapter", "acp", "diagnose", "doctor", "provider"],
    context: "global",
    async onSelect({ rpc, openScreen }) {
      await rpc(contracts.runDoctor, {});
      openScreen({ screenId: SCREEN_ID });
    },
  });

  client.addCommandCenterItem({
    id: `${PLUGIN_ID}-release-stale-locks`,
    title: `${PLUGIN_LABEL}: release stale session locks`,
    icon: "LockOpen",
    keywords: ["claude", "adapter", "acp", "lock", "session", "stale"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(contracts.releaseStaleLocks, {});
    },
  });

  return () => {};
}
