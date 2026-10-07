import { randomUUID } from "node:crypto";

/**
 * A general comment on GitHub, which has no draft on the pull request as a whole: kept by the plugin
 * under an ID it minted until a submit posts it as a comment of its own.
 */
export type BodyParagraph = { id: string; body: string };

const PARAGRAPH_ID_PREFIX = "paragraph-";

/** A new paragraph's ID, which no GitHub node ID (`PRRC_…`) can be mistaken for. */
export function paragraphId(): string {
  return `${PARAGRAPH_ID_PREFIX}${randomUUID()}`;
}

export function isParagraphId(draftId: string): boolean {
  return draftId.startsWith(PARAGRAPH_ID_PREFIX);
}
