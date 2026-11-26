import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { commandSchema } from "./commands.ts";
import { lastRunsSchema } from "./runs.ts";

const commandInput = z.object({ commandId: z.string() });
const done = z.object({ ok: z.literal(true) });

export const hostStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unsupported"), message: z.string() }),
  z.object({
    kind: z.literal("ready"),
    commands: z.array(commandSchema),
    /** Keyed by command ID; a command that never ran has no entry. */
    runs: lastRunsSchema,
  }),
]);
export type HostState = z.infer<typeof hostStateSchema>;

/** Sends the whole state on subscribe and again on every change. */
export const watchHost = defineSubscription({
  name: "quick-commands.watch",
  input: z.object({}),
  event: hostStateSchema,
});

/** Runs the saved command with this ID; the daemon never takes a command string from a client. */
export const runCommand = defineRpc({ name: "quick-commands.run", input: commandInput, output: done });

export const stopCommand = defineRpc({ name: "quick-commands.stop", input: commandInput, output: done });
