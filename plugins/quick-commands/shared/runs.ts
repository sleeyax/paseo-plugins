import { z } from "zod";

export const OUTPUT_LINE_LIMIT = 200;

/** `interrupted` is a run the daemon lost track of, such as one cut off by a reboot: its outcome is unknown, not failed. */
export const runStatusSchema = z.enum(["running", "succeeded", "failed", "stopped", "interrupted"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const lastRunSchema = z.object({
  status: runStatusSchema,
  exitCode: z.number().int().nullable(),
  /** Epoch milliseconds. */
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** The last lines of stdout and stderr together, without ANSI codes. */
  output: z.array(z.string()),
});
export type LastRun = z.infer<typeof lastRunSchema>;

export const lastRunsSchema = z.record(z.string(), lastRunSchema);
export type LastRuns = z.infer<typeof lastRunsSchema>;

export function isFinished(status: RunStatus): boolean {
  return status !== "running";
}
