import type { ForeignChangeRequest, ForeignWork } from "../shared/foreign-work.ts";
import { MAX_COMMITS } from "./forge/common.ts";
import type { ChangeRequest, CommitChangeRequest } from "./forge/port.ts";

/**
 * The commits of `changeRequest` that belong to other change requests, from `belongsTo`, what
 * `Forge.commitChangeRequests` said of each; null when there are none.
 *
 * Another change request counts when it is open or merged, so reviewed or under review elsewhere,
 * and comes from another branch: one from the same branch is this one's own earlier attempt, whose
 * commits are this one's work. A closed one's commits were never reviewed, so they are this one's too.
 */
export function foreignWorkOf(
  changeRequest: ChangeRequest,
  belongsTo: ReadonlyMap<string, readonly CommitChangeRequest[]>,
): Omit<ForeignWork, "ownPaths"> | null {
  const byNumber = new Map<number, ForeignChangeRequest>();
  for (const commit of changeRequest.commits) {
    for (const other of belongsTo.get(commit.sha) ?? []) {
      const { state } = other;
      if (other.sourceBranch === changeRequest.headBranch || (state !== "open" && state !== "merged")) continue;
      const entry = byNumber.get(other.number) ?? { ...other, state, commits: [] };
      entry.commits.push(commit.sha);
      byNumber.set(other.number, entry);
    }
  }
  if (byNumber.size === 0) return null;

  const foreign = new Set([...byNumber.values()].flatMap((other) => other.commits));
  const truncated = changeRequest.commits.length >= MAX_COMMITS;
  return {
    targetBranch: changeRequest.baseBranch,
    changeRequests: [...byNumber.values()],
    foreignCommits: foreign.size,
    totalCommits: changeRequest.commits.length,
    truncated,
    ownFrom: truncated ? null : (ownWork(changeRequest, foreign)?.from ?? null),
  };
}

/**
 * Where the change request's own work starts, when every foreign commit comes before it: `after` is
 * the last commit of the foreign work, the commit the own work was written on, and `from` the first
 * commit after it. Null when foreign commits come later, or there is no own work after them.
 *
 * The history is walked along first parents from the head, the line the branch itself was committed
 * on. Its commits, oldest first, belong to the foreign work while everything they reach within the
 * change request is foreign or a merge: a merge only brings other work in, like the one that pulled
 * a foreign branch in, or the target.
 */
export function ownWork(changeRequest: ChangeRequest, foreign: ReadonlySet<string>): { after: string; from: string } | null {
  const commits = new Map(changeRequest.commits.map((commit) => [commit.sha, commit]));
  const firstParents: string[] = [];
  for (let sha: string | undefined = changeRequest.headSha; sha !== undefined && commits.has(sha); sha = commits.get(sha)!.parents[0]) {
    firstParents.unshift(sha);
  }

  const reached = new Set<string>();
  const reach = (sha: string) => {
    const pending = [sha];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (reached.has(next) || !commits.has(next)) continue;
      reached.add(next);
      pending.push(...commits.get(next)!.parents);
    }
  };
  const foreignOrMerge = (sha: string) => foreign.has(sha) || commits.get(sha)!.parents.length > 1;

  let after: string | null = null;
  let covered = new Set<string>();
  for (const sha of firstParents) {
    reach(sha);
    if (![...reached].every(foreignOrMerge)) break;
    after = sha;
    covered = new Set(reached);
  }
  if (after === null) return null;
  const from = firstParents[firstParents.indexOf(after) + 1];
  if (from === undefined) return null;
  return [...foreign].every((sha) => covered.has(sha)) ? { after, from } : null;
}
