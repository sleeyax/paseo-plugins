import { z } from "zod";

/** What a submitted review says about the change as a whole. */
export const VERDICTS = ["approve", "request-changes", "comment"] as const;

export const VerdictSchema = z.enum(VERDICTS);

/** A verdict as the Finish review step offers it: on offer, or not and why. */
export const VerdictOptionSchema = z.object({
  verdict: VerdictSchema,
  allowed: z.boolean(),
  /** Why the verdict is not on offer, as a sentence; null when it is. */
  reason: z.string().nullable(),
  /** Held back only because the head moved since the guide was written, which Regenerate answers. */
  regenerate: z.boolean(),
});

/**
 * One call a submit made to the forge, and how it went, in the same words on every forge: GitHub
 * submits in one step, GitLab in several (publish, approve, confirm the reviewer state, fall back),
 * and any of those can fail after an earlier one landed, which is what the panel then reports.
 */
export const SubmitStepSchema = z.object({
  /** The adapter's own name for the step, like `submit` or `approve`. */
  id: z.string(),
  /** What the step does, as the panel lists it: "Publish the review and approve". */
  label: z.string(),
  /** `skipped` is a step not tried, because one it depends on failed or it was not needed. */
  status: z.enum(["done", "failed", "skipped"]),
  /** Why it failed or was skipped, as a sentence; for a done step, what it found when that is worth saying, else null. */
  message: z.string().nullable(),
});

export const SubmitResultSchema = z.discriminatedUnion("status", [
  /** Nothing was sent: the verdict is not on offer now, which `verdicts` says afresh. */
  z.object({ status: z.literal("refused"), message: z.string(), verdicts: z.array(VerdictOptionSchema) }),
  /**
   * The forge was asked. `submitted` when every step was done, `failed` when none was, `partial`
   * otherwise; `published` says whether the drafts and body are out, so none are pending any more.
   */
  z.object({
    status: z.enum(["submitted", "partial", "failed"]),
    published: z.boolean(),
    steps: z.array(SubmitStepSchema),
  }),
]);

export type Verdict = z.output<typeof VerdictSchema>;
export type VerdictOption = z.output<typeof VerdictOptionSchema>;
export type SubmitStep = z.output<typeof SubmitStepSchema>;
export type SubmitResult = z.output<typeof SubmitResultSchema>;

export const VERDICT_LABELS: Record<Verdict, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
};
