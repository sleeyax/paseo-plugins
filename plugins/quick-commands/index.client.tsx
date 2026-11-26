import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import React from "react";
import { commandCenterItems } from "./client/command-center.ts";
import { CommandsScreen } from "./client/commands-screen.tsx";
import * as contracts from "./shared/contracts.ts";
import { PLUGIN_ICON, PLUGIN_LABEL, SCREEN_ID } from "./shared/identity.ts";

function CommandsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={PLUGIN_ICON} active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />;
}

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({ id: SCREEN_ID, title: PLUGIN_LABEL, Component: CommandsScreen });
  const removeSidebarItem = client.addSidebarHeaderItem({ id: SCREEN_ID, title: PLUGIN_LABEL, Component: CommandsSidebarItem });

  const items = commandCenterItems((item) => client.addCommandCenterItem(item));
  const unsubscribe = client.subscribe(contracts.watchHost, {}, (state) => items.sync(state.kind === "ready" ? state.commands : []));

  return () => {
    unsubscribe();
    items.clear();
    removeSidebarItem();
    removeScreen();
  };
}
