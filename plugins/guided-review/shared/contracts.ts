import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FileDiffSchema } from "./diff.ts";
import { DraftListSchema, DraftLocationSchema, LinkedDraftSchema } from "./drafts.ts";
import { GuideStateSchema } from "./guide.ts";
import { GuideProgressSchema } from "./progress.ts";
import { SubmitResultSchema, VerdictOptionSchema, VerdictSchema } from "./submit.ts";

/** What the panel shows about a change request before any guide exists. */
export const ReviewHeaderSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  url: z.string(),
  /** `owner/repo`, or a GitLab project path. */
  project: z.string(),
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  fileCount: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  headSha: z.string(),
});

export const StartResultSchema = z.discriminatedUnion("status", [
  /** The URL is not one any forge takes; nothing was started. */
  z.object({ status: z.literal("rejected"), message: z.string() }),
  /** A background job is reading the change request and preparing its workspace; follow it by ID. */
  z.object({ status: z.literal("started"), reviewId: z.string() }),
]);

export const START_PHASES = ["reading", "updating-branch", "cloning", "creating-workspace", "ready", "failed", "unknown"] as const;

/**
 * Where starting a review has got to. `unknown` is a review this daemon has no record of, which is
 * what one started before a plugin restart and not finished reads as.
 */
export const StartProgressSchema = z.object({
  phase: z.enum(START_PHASES),
  /** Known once the change request has been read. */
  header: ReviewHeaderSchema.nullable(),
  /** Set when `ready`. */
  workspaceId: z.string().nullable(),
  /** Set when `failed`, as a sentence. */
  message: z.string().nullable(),
});

/** An open change request a workspace's branch is the source of, as the reviewer chooses between several. */
export const BranchCandidateSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  url: z.string(),
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
});

/**
 * Where guiding a workspace's branch has got to, in that workspace's panel. `none` is a branch no
 * open change request comes from; `started` follows the review, which may have gone to a PR
 * workspace, with `note` saying why the branch was left alone.
 */
export const BranchStartSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("finding") }),
  z.object({ status: z.literal("none"), message: z.string() }),
  z.object({ status: z.literal("failed"), message: z.string() }),
  z.object({ status: z.literal("choose"), branch: z.string(), candidates: z.array(BranchCandidateSchema) }),
  z.object({ status: z.literal("started"), reviewId: z.string(), progress: StartProgressSchema, note: z.string().nullable() }),
]);

export const PanelViewSchema = z.discriminatedUnion("status", [
  /** `branch` is set while this workspace's branch is being guided, or once that ended without a guide here. */
  z.object({ status: z.literal("none"), branch: BranchStartSchema.optional() }),
  z.object({
    status: z.literal("ready"),
    reviewId: z.string(),
    header: ReviewHeaderSchema,
    guide: GuideStateSchema,
    /** Why the reviewer's own branch was left alone and the guide lives in this PR workspace instead. */
    note: z.string().optional(),
  }),
]);

export const startReview = defineRpc({
  name: "guided-review.review.start",
  input: z.object({ url: z.string() }),
  output: StartResultSchema,
});

export const getStartProgress = defineRpc({
  name: "guided-review.review.progress",
  input: z.object({ reviewId: z.string() }),
  output: StartProgressSchema,
});

/**
 * Guides the open change request the workspace's branch is the source of: in that workspace once its
 * branch is fast-forwarded to the head, in a PR workspace when the branch cannot be. Returns at once;
 * the panel follows it through `getPanel`. `url` is the reviewer's choice when there were several.
 */
export const startBranchReview = defineRpc({
  name: "guided-review.review.start-branch",
  input: z.object({ workspaceId: z.string(), url: z.string().nullable() }),
  output: BranchStartSchema,
});

/** The panel has only its workspace's ID, so this is how it finds the review it belongs to. */
export const getPanel = defineRpc({
  name: "guided-review.panel.get",
  input: z.object({ workspaceId: z.string() }),
  output: PanelViewSchema,
});

/**
 * Generates the review's guide again, with a new guide agent: the panel's retry after a failure.
 * Returns at once; the panel follows the generation through `getPanel`.
 */
export const generateGuide = defineRpc({
  name: "guided-review.guide.generate",
  input: z.object({ reviewId: z.string() }),
  output: GuideStateSchema,
});

/**
 * A part of the guide the panel acts on: a node, or a changed file the guide keeps outside its
 * nodes, in its Supporting or Unsorted group. The server looks the rest up in the stored guide, so
 * what it answers with is what the guide says rather than what the panel sent.
 */
export const GuideSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);

export const AskResultSchema = z.discriminatedUnion("status", [
  /** The prompt is in the guide agent's chat, which the panel then opens. */
  z.object({ status: z.literal("sent"), agentId: z.string() }),
  /** Nothing was sent; `message` says why, as a sentence. `agentId` is set while there is an agent to open. */
  z.object({ status: z.literal("not-sent"), agentId: z.string().nullable(), message: z.string() }),
]);

/**
 * Sends the guide agent a prompt about the subject, for the reviewer to follow up in its chat. Only
 * an idle agent is sent to, because a prompt to a busy one would interrupt its turn.
 */
export const askAbout = defineRpc({
  name: "guided-review.guide.ask",
  input: z.object({ reviewId: z.string(), subject: GuideSubjectSchema }),
  output: AskResultSchema,
});

/**
 * The code a subject covers, ready to draw: a node's files in reading order, each cut down to the
 * node's hunks, or the whole diff of a changed file, as a Supporting or Unsorted entry shows it.
 */
export const NodeDiffSchema = z.object({
  /** The head the guide, and so these hunks, were read at. */
  headSha: z.string(),
  files: z.array(FileDiffSchema),
});

/** The hunks of a node, or of a changed file, of the review's current guide; fails while the guide is not ready. */
export const getNodeDiff = defineRpc({
  name: "guided-review.guide.node-diff",
  input: z.object({ reviewId: z.string(), subject: GuideSubjectSchema }),
  output: NodeDiffSchema,
});

/**
 * The reviewer's progress through the guide the panel shows, the one at the review's head SHA; null
 * while that guide is not ready.
 */
export const getProgress = defineRpc({
  name: "guided-review.progress.get",
  input: z.object({ reviewId: z.string() }),
  output: GuideProgressSchema.nullable(),
});

/**
 * Marks a subject of the guide at `headSha` understood, or clears the mark. The subjects are the
 * ones "Ask about this" takes: a node, or a Supporting or Unsorted entry. Returns the progress after.
 */
export const setUnderstood = defineRpc({
  name: "guided-review.progress.set",
  input: z.object({ reviewId: z.string(), headSha: z.string(), subject: GuideSubjectSchema, understood: z.boolean() }),
  output: GuideProgressSchema,
});

/**
 * The reviewer's drafts on the change request, as the forge has them, including ones started in
 * its web UI. Drafts live only on the forge, so this is read afresh every time. Each comes with the
 * node of the panel's guide it was written from, which only this plugin knows; null for the rest.
 */
export const listDrafts = defineRpc({
  name: "guided-review.drafts.list",
  input: z.object({ reviewId: z.string() }),
  output: DraftListSchema,
});

/**
 * Saves a comment as a forge draft at once, unpublished until the review is submitted. The location
 * names lines of the diff the panel drew at `headSha`, the head of the guide it showed, which the
 * server looks up at that head; a head the review has since been regenerated away from is refused.
 */
export const createDraft = defineRpc({
  name: "guided-review.drafts.create",
  input: z.object({
    reviewId: z.string(),
    headSha: z.string(),
    location: DraftLocationSchema,
    body: z.string(),
    /**
     * The node of the guide at `headSha` the comment was written from: a node's own comment, or one
     * on code drawn in a node. Kept here, keyed by the draft's ID, and never posted.
     */
    nodeId: z.string().nullable().optional(),
  }),
  output: LinkedDraftSchema,
});

export const updateDraft = defineRpc({
  name: "guided-review.drafts.update",
  input: z.object({ reviewId: z.string(), draftId: z.string(), body: z.string() }),
  output: z.null(),
});

export const deleteDraft = defineRpc({
  name: "guided-review.drafts.delete",
  input: z.object({ reviewId: z.string(), draftId: z.string() }),
  output: z.null(),
});

/**
 * Whether the PR/MR's head has moved on since the panel's guide was written, as the forge has it
 * now: what the "PR updated since this guide" banner shows, and what a verdict needs to know.
 */
export const HeadCheckSchema = z.object({
  /** The head the panel's guide, and its header, were read at. */
  guideHeadSha: z.string(),
  /** Where the forge has the head now; null when it could not be asked, with `message` saying why. */
  forgeHeadSha: z.string().nullable(),
  /** New commits were pushed, or the branch was rewritten, since the guide was written. False when unknown. */
  moved: z.boolean(),
  /** The state the forge has the PR/MR in now; null when it could not be asked. */
  state: z.enum(["open", "closed", "merged"]).nullable(),
  /** Why the forge could not be asked, as a sentence. */
  message: z.string().nullable(),
});

/**
 * Asks the forge where the review's head is now. Nothing changes on its own when it has moved: the
 * panel shows a banner and `regenerateGuide` is the only way to a guide at the new head.
 */
export const checkHead = defineRpc({
  name: "guided-review.review.head",
  input: z.object({ reviewId: z.string() }),
  output: HeadCheckSchema,
});

/**
 * "Regenerate": reads the PR/MR at its current head, brings the guide's workspace to that head, and
 * generates a guide for it, carrying the reviewer's marks over to nodes whose code did not change.
 * Returns at once; the panel follows it through `getStartProgress`, whose `workspaceId` is the
 * workspace the new guide lives in, which is a new PR workspace when the old one could not be moved.
 */
export const regenerateGuide = defineRpc({
  name: "guided-review.guide.regenerate",
  input: z.object({ reviewId: z.string() }),
  output: StartResultSchema,
});

/** What the Finish review step opens on; the drafts it lists are `listDrafts`'. */
export const FinishViewSchema = z.object({
  /** The review body as it is kept until submit: on the pending review on GitHub, here on GitLab. */
  body: z.string(),
  /** Every verdict, on offer or not, from the head as the forge has it now. */
  verdicts: z.array(VerdictOptionSchema),
  /** The head check the verdicts were decided by, which the panel's banner then shows too. */
  head: HeadCheckSchema,
});

export const getFinish = defineRpc({
  name: "guided-review.review.finish",
  input: z.object({ reviewId: z.string() }),
  output: FinishViewSchema,
});

/** Keeps the review body until submit, where the forge keeps it or, on a forge that keeps none, here. */
export const saveReviewBody = defineRpc({
  name: "guided-review.review.body",
  input: z.object({ reviewId: z.string(), body: z.string() }),
  output: z.null(),
});

/**
 * Publishes the drafts and the body with the verdict. The head is checked with the forge again first,
 * and a verdict not on offer then is refused with nothing sent; `headSha` is the head of the guide
 * the panel showed, and one the review has since been regenerated away from is refused too.
 */
export const submitReview = defineRpc({
  name: "guided-review.review.submit",
  input: z.object({ reviewId: z.string(), headSha: z.string(), verdict: VerdictSchema, body: z.string() }),
  output: SubmitResultSchema,
});

/** Throws away the pending review, its drafts and its body. */
export const discardReview = defineRpc({
  name: "guided-review.review.discard",
  input: z.object({ reviewId: z.string() }),
  output: z.null(),
});

export type FinishView = z.output<typeof FinishViewSchema>;

export type HeadCheck = z.output<typeof HeadCheckSchema>;

/**
 * What a comment box is for, as "Suggest wording" names it: a comment on code at a draft location,
 * or a node's comment, on the change as a whole. The server looks the lines and the guide's nodes up
 * itself, as for "Ask about this".
 */
export const CommentSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), location: DraftLocationSchema }),
  z.object({ kind: z.literal("node"), nodeId: z.string() }),
]);

/**
 * Where a "Suggest wording" request has got to. `ready` carries the text for the box, which nothing
 * saves; `failed` says why there is none, as a sentence.
 */
export const SuggestionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), suggestionId: z.string() }),
  z.object({ status: z.literal("ready"), body: z.string() }),
  z.object({ status: z.literal("failed"), message: z.string() }),
]);

/**
 * Has the guide agent word a comment from where it goes and `prompt`, whatever the reviewer typed.
 * The agent can take longer than an RPC may, so this starts it and the panel follows it through
 * `getSuggestion`. Only an idle agent is asked; nothing is saved or posted. As for `createDraft`,
 * `headSha` is the head of the guide the panel drew, and one the review has been regenerated away
 * from is refused.
 */
export const suggestWording = defineRpc({
  name: "guided-review.drafts.suggest",
  input: z.object({ reviewId: z.string(), headSha: z.string(), subject: CommentSubjectSchema, prompt: z.string() }),
  output: SuggestionSchema,
});

/** A suggestion `suggestWording` started; a finished one is handed out once. */
export const getSuggestion = defineRpc({
  name: "guided-review.drafts.suggestion",
  input: z.object({ suggestionId: z.string() }),
  output: SuggestionSchema,
});

export type ReviewHeader = z.output<typeof ReviewHeaderSchema>;
export type NodeDiff = z.output<typeof NodeDiffSchema>;
export type StartResult = z.output<typeof StartResultSchema>;
export type StartPhase = (typeof START_PHASES)[number];
export type StartProgress = z.output<typeof StartProgressSchema>;
export type PanelView = z.output<typeof PanelViewSchema>;
export type GuideSubject = z.output<typeof GuideSubjectSchema>;
export type AskResult = z.output<typeof AskResultSchema>;
export type CommentSubject = z.output<typeof CommentSubjectSchema>;
export type Suggestion = z.output<typeof SuggestionSchema>;

/** Tells one subject apart from another in the panel, as for its "Ask about this" and its code. */
export function subjectKey(subject: GuideSubject): string {
  return subject.kind === "node" ? `node:${subject.nodeId}` : `file:${subject.path}`;
}
export type BranchCandidate = z.output<typeof BranchCandidateSchema>;
export type BranchStart = z.output<typeof BranchStartSchema>;
