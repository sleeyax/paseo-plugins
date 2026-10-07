import type { Description, HeadCheck } from "../shared/contracts.ts";

/**
 * The description the panel shows: the one read with the guide, unless the forge has it edited since,
 * which an author does without pushing. A head check of another guide's head says nothing about it.
 */
export function shownDescription(description: Description, head: HeadCheck | null): { text: string; edited: boolean } {
  const live = head !== null && head.guideHeadSha === description.headSha ? head.description : null;
  if (live === null || live === description.description) return { text: description.description, edited: false };
  return { text: live, edited: true };
}
