import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FileDiffSchema } from "./diff.ts";
import { GuideStateSchema } from "./guide.ts";
import { GuideProgressSchema } from "./progress.ts";

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

export type ReviewHeader = z.output<typeof ReviewHeaderSchema>;
export type NodeDiff = z.output<typeof NodeDiffSchema>;
export type StartResult = z.output<typeof StartResultSchema>;
export type StartPhase = (typeof START_PHASES)[number];
export type StartProgress = z.output<typeof StartProgressSchema>;
export type PanelView = z.output<typeof PanelViewSchema>;
export type GuideSubject = z.output<typeof GuideSubjectSchema>;
export type AskResult = z.output<typeof AskResultSchema>;

/** Tells one subject apart from another in the panel, as for its "Ask about this" and its code. */
export function subjectKey(subject: GuideSubject): string {
  return subject.kind === "node" ? `node:${subject.nodeId}` : `file:${subject.path}`;
}
export type BranchCandidate = z.output<typeof BranchCandidateSchema>;
export type BranchStart = z.output<typeof BranchStartSchema>;
