import type { HeadCheck } from "../shared/contracts.ts";
import { describeHeadChange, shortSha } from "../shared/head-change.ts";
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
 * nothing. When the head moved since the guide, or could not be checked, they stay on offer with a
 * warning, since the reviewer may judge the guide enough. Discard is not a verdict, and is always on offer.
 */
export function verdictOptions(rules: VerdictRules): VerdictOption[] {
  const held = heldBack(rules);
  const warning = held === null ? headWarning(rules) : null;
  return VERDICTS.map((verdict) => {
    if (verdict === "comment") return { verdict, allowed: true, reason: null, warning: null, regenerate: false };
    if (held !== null) return { verdict, allowed: false, reason: held, warning: null, regenerate: false };
    return { verdict, allowed: true, reason: null, warning, regenerate: rules.head.moved };
  });
}

function heldBack({ forge, own, state }: VerdictRules): string | null {
  const noun = nounOf(forge);
  if (own) return `This is your own ${noun}, so your review can only comment.`;
  if (state !== "open") return `This ${noun} is ${state}, so your review can only comment.`;
  return null;
}

function headWarning({ forge, head }: VerdictRules): string | null {
  const noun = nounOf(forge);
  if (head.forgeHeadSha === null) {
    const why = head.message ?? `Could not check the ${noun} for new commits`;
    return `${/[.!?]$/.test(why) ? why : `${why}.`} It may have commits the guide did not explain, which a verdict would apply to as well.`;
  }
  if (head.moved) {
    const change = `${describeHeadChange(head)} since this guide (${shortSha(head.guideHeadSha)} → ${shortSha(head.forgeHeadSha)})`;
    return `${change}, so a verdict would apply to code it did not explain. Regenerate the guide to read them first.`;
  }
  return null;
}

/**
 * Whether the head check at submit warns of something other than what the reviewer was shown, given the
 * forge head their Finish review step read: a verdict goes out only under the warning they saw.
 */
export function warnedOfAnotherHead(head: HeadCheck, seenForgeHeadSha: string | null): boolean {
  const warns = head.moved || head.forgeHeadSha === null;
  return warns && head.forgeHeadSha !== seenForgeHeadSha;
}

function nounOf(forge: ForgeKind): string {
  return forge === "gitlab" ? "MR" : "PR";
}
