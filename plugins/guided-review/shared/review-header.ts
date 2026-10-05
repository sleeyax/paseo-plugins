import { z } from "zod";

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

export const START_PHASES = ["reading", "updating-branch", "cloning", "creating-workspace", "ready", "failed", "unknown"] as const;
