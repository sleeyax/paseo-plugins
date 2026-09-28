import { randomUUID } from "node:crypto";

/**
 * A node's comment on GitHub, which has no draft of its own there: a paragraph of the pending
 * review's body, beside the reviewer's own text. Nothing on GitHub says which paragraphs are node
 * comments, and nothing the plugin posts may, so the plugin keeps each one's text under an ID it
 * minted and finds it again in the body as a paragraph with exactly that text.
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

/** The body the forge keeps: the reviewer's own text, then each paragraph, with a blank line between. */
export function composeBody(own: string, paragraphs: readonly BodyParagraph[]): string {
  return [own, ...paragraphs.map((paragraph) => paragraph.body)]
    .map((text) => normalise(text).trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Takes the paragraphs kept here back out of the body as the forge has it: each one found whole,
 * between blank lines or the ends of the body, and the last such place first, since they were
 * written after the reviewer's own text. What is left is the reviewer's own text. A paragraph that
 * is no longer there whole, edited or deleted on the web, is not found, and whatever became of its
 * text stays in `own`, so nothing the reviewer can see is lost.
 */
export function splitBody(body: string, paragraphs: readonly BodyParagraph[]): { own: string; found: BodyParagraph[] } {
  let rest = normalise(body);
  const found: BodyParagraph[] = [];
  for (const paragraph of paragraphs) {
    const text = normalise(paragraph.body).trim();
    const at = text === "" ? -1 : lastWhole(rest, text);
    if (at === -1) continue;
    const before = rest.slice(0, at).trimEnd();
    const after = rest.slice(at + text.length).trimStart();
    rest = before === "" || after === "" ? `${before}${after}` : `${before}\n\n${after}`;
    found.push(paragraph);
  }
  return { own: rest.trim(), found };
}

/** Where `text` last stands as whole paragraphs of `body`, or -1. */
function lastWhole(body: string, text: string): number {
  for (let from = body.length; from >= 0; ) {
    const at = body.lastIndexOf(text, from);
    if (at === -1) return -1;
    const before = body.slice(0, at);
    const after = body.slice(at + text.length);
    const opens = before.trim() === "" || /\n[ \t]*\n\s*$/.test(before);
    const closes = after.trim() === "" || /^[ \t]*\n[ \t]*\n/.test(after);
    if (opens && closes) return at;
    from = at - 1;
  }
  return -1;
}

/** GitHub keeps what is typed on its web page with CRLF line ends. */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
