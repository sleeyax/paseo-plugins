import { z } from "zod";
import { ReviewHeaderSchema, START_PHASES } from "./review-header.ts";

/**
 * Where the reviewer stands on a change request they review, in the same words on both forges.
 * `unapproved` is an approval the forge took back, as GitLab does when the author pushes after it.
 */
export const ReviewerStateSchema = z.enum(["requested", "commented", "changes-requested", "approved", "unapproved"]);

/** The head's CI as one word; null when it has none, or one in a state neither of these is, like a cancelled pipeline. */
export const CiStateSchema = z.enum(["success", "failure", "pending"]);

/** An open change request the reviewer is one of the reviewers of, as a forge lists it. */
export const ReviewRequestSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  /** The web host, lower-cased: `github.com`. */
  host: z.string(),
  /** `owner/repo`, or a GitLab project path. */
  project: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headSha: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  fileCount: z.number().int(),
  ci: CiStateSchema.nullable(),
  state: ReviewerStateSchema,
  /** The team the review was asked of, `org/team`, when it was not asked of the reviewer by name. */
  viaTeam: z.string().nullable(),
  /**
   * Whether the change request moved on since the reviewer's last review: a push, or being asked
   * again. Null when they never reviewed it, or the forge cannot say.
   */
  changedSinceReview: z.boolean().nullable(),
  /** The reviewer's unpublished comments on it; null where the forge cannot count them cheaply. */
  pendingDrafts: z.number().int().nullable(),
});

export type ReviewerState = z.output<typeof ReviewerStateSchema>;
export type CiState = z.output<typeof CiStateSchema>;
export type ReviewRequest = z.output<typeof ReviewRequestSchema>;

/** What one host of a forge listed, or why it could not, so one host failing leaves the others listed. */
export const ReviewRequestHostSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  host: z.string(),
  requests: z.array(ReviewRequestSchema),
  /** The host has more than were listed. */
  truncated: z.boolean(),
  /** Why the host could not be listed, as a sentence; its `requests` are then empty. */
  error: z.string().nullable(),
});

export type ReviewRequestHost = z.output<typeof ReviewRequestHostSchema>;

/**
 * What this plugin has of a change request's review, if the reviewer started one here: the start
 * or Regenerate still running, or how it failed, where its guide stands at the head it was read at,
 * and its workspace while that is open.
 */
export const LocalReviewSchema = z.object({
  /** The change request as the review has it; null until a first start has read it. */
  header: ReviewHeaderSchema.nullable(),
  /** The review's start or Regenerate while it runs, and once it failed. */
  preparing: z.object({ phase: z.enum(START_PHASES), message: z.string().nullable() }).nullable(),
  guide: z.enum(["none", "generating", "ready", "failed"]),
  workspaceId: z.string().nullable(),
});

export const InboxItemSchema = ReviewRequestSchema.extend({
  /** The ID a review of it is kept under; null when it cannot be kept. */
  reviewId: z.string().nullable(),
  local: LocalReviewSchema.nullable(),
  /** The reviewer set it aside on this list, the forge none the wiser, until it moves on (`server/inbox-check-offs.ts`). */
  checkedOff: z.boolean(),
});

/** What the reviewer saw of a change request when they checked it off. */
export const CheckOffSchema = z.object({ headSha: z.string(), state: ReviewerStateSchema });

/** Every host's review requests, each joined with the review started here, if any. */
export const InboxSchema = z.object({
  hosts: z.array(ReviewRequestHostSchema.omit({ requests: true })),
  items: z.array(InboxItemSchema),
});

export type LocalReview = z.output<typeof LocalReviewSchema>;
export type CheckOff = z.output<typeof CheckOffSchema>;
export type InboxItem = z.output<typeof InboxItemSchema>;
export type Inbox = z.output<typeof InboxSchema>;

/** Whether the forge's head moved past the one the review here was read at. */
export function headMoved(item: ReviewRequest, local: LocalReview): boolean {
  return local.header !== null && item.headSha !== "" && item.headSha !== local.header.headSha;
}
