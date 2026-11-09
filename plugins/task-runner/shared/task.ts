import { z } from "zod";

/** Each task's terminal is named with this, which is how a run is found again with no stored state. */
export const TASK_TERMINAL_PREFIX = "task: ";

export const taskSchema = z.object({
  /** The task's terminal name, which is unique within a workspace. */
  id: z.string(),
  label: z.string(),
  group: z.string(),
  source: z.string(),
  /** Shell text, so a `.vscode/tasks.json` command like `npm run build` works as written. */
  command: z.string(),
  /** Passed as literal arguments: each is quoted before it reaches the shell. */
  args: z.array(z.string()),
  cwd: z.string(),
  description: z.string().nullable(),
  /** Why the task cannot run; it is still listed. */
  disabledReason: z.string().nullable(),
});

export type Task = z.infer<typeof taskSchema>;

export const nxStatusSchema = z.object({
  /** `off` until the user asks; `loading` lists the files' targets while the Nx CLI runs. */
  inferred: z.enum(["off", "loading", "on", "failed"]),
  failure: z.string().nullable(),
});

export type NxStatus = z.infer<typeof nxStatusSchema>;

export const runStateSchema = z.object({
  taskId: z.string(),
  terminalId: z.string(),
  status: z.enum(["running", "stopping", "stopped", "succeeded", "failed"]),
  exitCode: z.number().int().nullable(),
  canForceKill: z.boolean(),
  /** The end of the task's output, oldest line first. */
  output: z.array(z.string()),
});

export type RunState = z.infer<typeof runStateSchema>;

export function isRunActive(run: RunState): boolean {
  return run.status === "running" || run.status === "stopping";
}
