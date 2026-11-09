import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { nxStatusSchema, runStateSchema, taskSchema } from "./task.ts";

const workspaceInput = z.object({ workspaceId: z.string() });
const terminalInput = workspaceInput.extend({ terminalId: z.string() });
const done = z.object({ ok: z.literal(true) });

export const listTasks = defineRpc({
  name: "task-runner.list",
  input: workspaceInput,
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unsupported"), message: z.string() }),
    z.object({ kind: z.literal("ready"), tasks: z.array(taskSchema), nx: nxStatusSchema.nullable() }),
  ]),
});

export const getRuns = defineRpc({
  name: "task-runner.runs",
  input: workspaceInput,
  output: z.object({ runs: z.array(runStateSchema) }),
});

export const runTask = defineRpc({
  name: "task-runner.run",
  input: workspaceInput.extend({ task: taskSchema }),
  output: done,
});

export const stopTask = defineRpc({ name: "task-runner.stop", input: terminalInput, output: done });

export const forceKillTask = defineRpc({ name: "task-runner.force-kill", input: terminalInput, output: done });
