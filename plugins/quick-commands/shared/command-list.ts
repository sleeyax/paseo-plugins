import type { Command } from "./commands.ts";

/** Replaces the command with the same ID, or appends it. */
export function upsertCommand(commands: readonly Command[], command: Command): Command[] {
  const index = commands.findIndex((existing) => existing.id === command.id);
  if (index === -1) return [...commands, command];
  return commands.map((existing, at) => (at === index ? command : existing));
}

export function removeCommand(commands: readonly Command[], id: string): Command[] {
  return commands.filter((command) => command.id !== id);
}

/** Swaps the command with its neighbour; a move past either end leaves the list as it is. */
export function moveCommand(commands: readonly Command[], id: string, direction: -1 | 1): Command[] {
  const from = commands.findIndex((command) => command.id === id);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= commands.length) return [...commands];
  const next = [...commands];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** No crypto.randomUUID on every client runtime; the ID only has to be unique within one host's list. */
export function newCommandId(now: number = Date.now(), random: () => number = Math.random): string {
  return `${now.toString(36)}-${random().toString(36).slice(2, 8)}`;
}
