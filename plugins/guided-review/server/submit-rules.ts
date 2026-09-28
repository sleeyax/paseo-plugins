import type { HeadCheck } from "../shared/contracts.ts";
import { VERDICTS, type VerdictOption } from "../shared/submit.ts";
import type { ChangeRequestState, ForgeKind } from "./forge/port.ts";

export type VerdictRules = {
  forge: ForgeKind;
  /** The reviewer is the change request's author. */
  own: boolean;
  /** The change request's state, as the forge has it now where it could be asked. */
  state: ChangeRequestState;
  /** Where the forge has the head now, against the guide's. */
  head: HeadCheck;
};

/**
 * The verdicts on offer. Comment always is. Approve and Request changes are not on the reviewer's own
 * change request, nor on a closed or merged one, where the forge would refuse them or they would mean
 * nothing; nor when the head moved since the guide, or could not be checked, since a verdict must only
 * ever apply to code the guide explained. Discard is not a verdict, and is always on offer.
 */
export function verdictOptions(rules: VerdictRules): VerdictOption[] {
  const held = heldBack(rules);
  return VERDICTS.map((verdict) =>
    verdict === "comment" || held === null
      ? { verdict, allowed: true, reason: null, regenerate: false }
      : { verdict, allowed: false, reason: held.reason, regenerate: held.regenerate },
  );
}

function heldBack({ forge, own, state, head }: VerdictRules): { reason: string; regenerate: boolean } | null {
  const noun = forge === "gitlab" ? "MR" : "PR";
  if (own) return { reason: `This is your own ${noun}, so your review can only comment.`, regenerate: false };
  if (state !== "open") return { reason: `This ${noun} is ${state}, so your review can only comment.`, regenerate: false };
  if (head.forgeHeadSha === null) {
    const why = head.message ?? `Could not check the ${noun} for new commits`;
    return {
      reason: `${/[.!?]$/.test(why) ? why : `${why}.`} Until it can be, your review can only comment, since a verdict must apply to the code the guide explained.`,
      regenerate: false,
    };
  }
  if (head.moved) {
    return {
      reason: `The ${noun} has new commits since this guide, so a verdict would apply to code it did not explain. Regenerate the guide to approve or request changes.`,
      regenerate: true,
    };
  }
  return null;
}
