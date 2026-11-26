import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginGlobalCommandContext } from "@getpaseo/plugin/client";
import { commandIcon, type Command, type CommandIcon } from "../shared/commands.ts";
import * as contracts from "../shared/contracts.ts";
import { SCREEN_ID } from "../shared/identity.ts";
import type { ScreenParams } from "./commands-screen.tsx";

export interface CommandCenterItem {
  id: string;
  title: string;
  icon: CommandIcon;
  keywords: readonly string[];
  context: "global";
  onSelect(context: PluginGlobalCommandContext): Promise<void>;
}

/**
 * Keeps one Command Center item per saved command, re-registering an item whose command changed.
 * Returns the function to call with each new list; calling `clear` removes every item.
 */
export function commandCenterItems(add: (item: CommandCenterItem) => PluginCleanup) {
  const registered = new Map<string, { key: string; remove: PluginCleanup }>();

  const sync = (commands: readonly Command[]) => {
    const wanted = new Map(commands.map((command) => [command.id, command]));
    for (const [id, entry] of registered) {
      const command = wanted.get(id);
      if (command && itemKey(command) === entry.key) continue;
      void entry.remove();
      registered.delete(id);
    }
    for (const command of commands) {
      if (registered.has(command.id)) continue;
      registered.set(command.id, { key: itemKey(command), remove: add(itemFor(command)) });
    }
  };

  const clear = () => sync([]);
  return { sync, clear };
}

function itemFor(command: Command): CommandCenterItem {
  return {
    id: `run-${command.id}`,
    title: `Run: ${command.name}`,
    icon: commandIcon(command),
    keywords: ["quick command", "run", "shell"],
    context: "global",
    // A Command Center item cannot show a dialog, so a command that asks first hands over to the screen.
    async onSelect({ rpc, openScreen }) {
      const open = (params: ScreenParams) => openScreen({ screenId: SCREEN_ID, params: { ...params, at: String(Date.now()) } });
      if (command.confirm) {
        open({ confirm: command.id });
        return;
      }
      try {
        await rpc(contracts.runCommand, { commandId: command.id });
      } finally {
        open({ focus: command.id });
      }
    },
  };
}

function itemKey(command: Command): string {
  return JSON.stringify([command.name, commandIcon(command), command.confirm]);
}
