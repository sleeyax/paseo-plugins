import { z } from "zod";

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
