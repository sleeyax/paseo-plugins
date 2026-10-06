import { z } from "zod";
import { shortSha } from "./head-change.ts";
import { numberLabel } from "./reference.ts";

/** Another change request whose commits this one's branch carries: one it did not branch from the target to make. */
export const ForeignChangeRequestSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  /** Still open is under review elsewhere; merged was reviewed, into `targetBranch`. */
  state: z.enum(["open", "merged"]),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  /** Its commits on this change request, oldest first. */
  commits: z.array(z.string()),
});

/**
 * The commits of a change request that belong to others, which its diff shows as its own because
 * its target branch does not have them yet.
 */
export const ForeignWorkSchema = z.object({
  /** The change request's own target, which lacks the foreign work. */
  targetBranch: z.string(),
  changeRequests: z.array(ForeignChangeRequestSchema).min(1),
  /** The commits that belong to another change request, each once. */
  foreignCommits: z.number().int(),
  totalCommits: z.number().int(),
  /** The forge listed only the first commits, so there may be more foreign ones. */
  truncated: z.boolean(),
  /**
   * The first commit of the change request's own work, when all the foreign work comes before it:
   * null when the two are interleaved, or the commits are `truncated`.
   */
  ownFrom: z.string().nullable(),
  /**
   * The files the own work changes, which a guide of the own work alone is written from: null when
   * `ownFrom` is, or the forge could not list them all.
   */
  ownPaths: z.array(z.string()).nullable(),
});

/** What a guide is written from: the whole diff, or only the files the change request's own work changes. */
export const REVIEW_SCOPES = ["full", "own"] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export type ForeignChangeRequest = z.output<typeof ForeignChangeRequestSchema>;
export type ForeignWork = z.output<typeof ForeignWorkSchema>;

/** Whether a guide can be written from the own work alone, which needs the files it changes. */
export function canNarrow(work: ForeignWork | undefined): work is ForeignWork & { ownPaths: string[] } {
  return work?.ownPaths != null;
}

/** The forge's word for a change request. */
export function changeRequestKind(forge: "github" | "gitlab"): "MR" | "PR" {
  return forge === "gitlab" ? "MR" : "PR";
}

/** "26 of the MR's 37 commits", or "at least 26 of the MR's commits" when the forge cut the list off. */
export function describeForeignCount(work: ForeignWork, forge: "github" | "gitlab", whose: "the" | "this" = "the"): string {
  const kind = changeRequestKind(forge);
  return work.truncated
    ? `at least ${work.foreignCommits} of ${whose} ${kind}'s commits`
    : `${work.foreignCommits} of ${whose} ${kind}'s ${work.totalCommits} commits`;
}

/**
 * The comment that asks the author to take the foreign work out of the diff, for the reviewer to
 * edit before it is posted: which change requests it comes from, what to do about each, and where
 * the change request's own work starts.
 */
export function headsUpNote(work: ForeignWork, forge: "github" | "gitlab"): string {
  const kind = changeRequestKind(forge);
  const target = code(work.targetBranch);
  const lines = work.changeRequests.map((other) => {
    const label = numberLabel(forge, other.number);
    const range = other.commits.length === 1 ? code(shortSha(other.commits[0]!)) : `${code(shortSha(other.commits[0]!))}…${code(shortSha(other.commits.at(-1)!))}`;
    return other.state === "merged"
      ? `- ${label} (${range}) landed in ${code(other.targetBranch)} but isn't in ${target} yet: retarget this ${kind} to ${code(other.targetBranch)}, or bring ${label} into ${target}.`
      : `- ${label} (${range}) is still open: target its branch ${code(other.sourceBranch)} so this ${kind} stacks on it, or wait for it to land in ${target}.`;
  });
  const own = work.ownFrom === null ? [] : [`This ${kind}'s own work is only the commits from ${code(shortSha(work.ownFrom))} onward.`];
  return [
    `Heads-up: ${describeForeignCount(work, forge, "this")} come from other ${kind}s, so the diff shows their changes as this ${kind}'s:`,
    "",
    ...lines,
    "",
    ...own,
    `Could you sort that out, so the diff shows only this ${kind}'s changes?`,
  ].join("\n");
}

function code(text: string): string {
  return `\`${text}\``;
}
