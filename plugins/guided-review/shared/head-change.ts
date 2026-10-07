import type { HeadCheck } from "./contracts.ts";

/** What happened to the branch since the guide's head, as the start of a sentence: "3 new commits were pushed". */
export function describeHeadChange(head: Pick<HeadCheck, "newCommits" | "rewritten">): string {
  if (head.rewritten) return "The branch was rewritten";
  if (head.newCommits === 1) return "1 new commit was pushed";
  if (head.newCommits !== null) return `${head.newCommits} new commits were pushed`;
  return "New commits were pushed";
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
