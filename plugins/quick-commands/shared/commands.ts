import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PLUGIN_ID } from "./identity.ts";

/**
 * A Command Center item with an icon Lucide does not know fails the whole plugin at registration, so a command can only pick from these.
 * Each name is checked against Lucide; a new one has to be too.
 */
export const COMMAND_ICONS = [
  "Terminal",
  "Power",
  "PowerOff",
  "RotateCcw",
  "RefreshCw",
  "Server",
  "Database",
  "HardDrive",
  "Download",
  "Upload",
  "Archive",
  "Play",
  "Trash2",
  "Wrench",
  "Settings",
  "Rocket",
  "Zap",
  "Shield",
  "Lock",
  "Wifi",
  "Globe",
  "Bell",
  "Package",
  "GitBranch",
  "Container",
  "Monitor",
  "Cpu",
] as const;

export const DEFAULT_COMMAND_ICON = "Terminal";

export const commandIconSchema = z.enum(COMMAND_ICONS);
export type CommandIcon = z.infer<typeof commandIconSchema>;

export const commandSchema = z.object({
  /** Stable across renames and reordering: Command Center items and last runs are keyed by it. */
  id: z.string().min(1),
  name: z.string().trim().min(1),
  command: z.string().trim().min(1),
  icon: commandIconSchema.optional(),
  confirm: z.boolean().default(false),
});
export type Command = z.infer<typeof commandSchema>;

export const commandsDocument = defineSettings({
  id: PLUGIN_ID,
  scope: "host",
  version: 1,
  schema: z.object({
    commands: z.array(commandSchema).default([]),
  }),
});

export function commandIcon(command: Pick<Command, "icon">): CommandIcon {
  return command.icon ?? DEFAULT_COMMAND_ICON;
}
