import { z } from "zod";
import type { DiffLine } from "./diff.ts";

/**
 * Where a draft sits, in the same words on both forges and in both directions: what the panel asks
 * for when the reviewer comments, and what the forge's listing says about a draft, whoever started it.
 *
 * A line is named by one side of the diff and its number there. A removed line is on the old side;
 * an added or unchanged line on the new side, which is where both forges put a comment on an
 * unchanged line by default. Each old and each new number appears once in a file's diff, so a
 * `LineRef` names one line of it.
 */
export const LineRefSchema = z.object({
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
});

export const DraftLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), path: z.string(), line: LineRefSchema }),
  /** Lines `start` to `end` of one hunk, in the diff's order. */
  z.object({ kind: z.literal("range"), path: z.string(), start: LineRefSchema, end: LineRefSchema }),
  /** The file as a whole, not any line of it. */
  z.object({ kind: z.literal("file"), path: z.string() }),
  /**
   * The change as a whole, on no file: a GitLab draft note without a position, which becomes a thread
   * of its own on the merge request, or a paragraph of the GitHub pending review's body. What the
   * panel writes here is a comment on a node or on the overview; which is kept locally, never on the forge.
   */
  z.object({ kind: z.literal("general") }),
]);

/** One of the reviewer's unpublished comments, as it is on the forge. */
export const DraftSchema = z.object({
  /** The forge's own ID for the comment, which editing and deleting it take. */
  id: z.string(),
  body: z.string(),
  location: DraftLocationSchema,
});

/** The part of the guide a comment was written from: one of its nodes, or its overview. */
export const CommentOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: z.string() }),
  z.object({ kind: z.literal("overview") }),
]);

export const QuoteSchema = z.string().trim().min(1);

/**
 * A draft as the panel lists it: as the forge has it, with the part of the guide it was written from
 * when the panel wrote it there, and the passage of the guide the reviewer highlighted for it, if any.
 * `earlier` says the passage is from a guide the one shown has replaced. Both are kept locally and
 * never posted; a draft started on the web, or from a Supporting or Unsorted file, has no origin.
 */
export const LinkedDraftSchema = DraftSchema.extend({
  from: CommentOriginSchema.nullable(),
  quote: z.object({ text: z.string(), earlier: z.boolean() }).nullable(),
});

export const DraftListSchema = z.object({ drafts: z.array(LinkedDraftSchema) });

export type LineRef = z.output<typeof LineRefSchema>;
export type CommentOrigin = z.output<typeof CommentOriginSchema>;
export type DraftLocation = z.output<typeof DraftLocationSchema>;
export type Draft = z.output<typeof DraftSchema>;
export type LinkedDraft = z.output<typeof LinkedDraftSchema>;
export type DraftList = z.output<typeof DraftListSchema>;

/** How a draft on `line` names it. */
export function lineRefOf(line: Pick<DiffLine, "kind" | "oldLine" | "newLine">): LineRef {
  return line.kind === "removed" ? { side: "old", line: line.oldLine! } : { side: "new", line: line.newLine! };
}

/** Whether `ref` names `line`; an unchanged line answers to its old number as well as its new one. */
export function isLine(line: Pick<DiffLine, "oldLine" | "newLine">, ref: LineRef): boolean {
  return (ref.side === "old" ? line.oldLine : line.newLine) === ref.line;
}

/** The file a draft is on; null for one on the change as a whole. */
export function pathOf(location: DraftLocation): string | null {
  return location.kind === "general" ? null : location.path;
}

/** The line a draft is shown under: its only line, or a range's last. Null for a file's draft, or a general one. */
export function lastLineOf(location: DraftLocation): LineRef | null {
  switch (location.kind) {
    case "line":
      return location.line;
    case "range":
      return location.end;
    case "file":
    case "general":
      return null;
  }
}

/** Where a draft is, in a few words: "line 12", "old lines 3–5", "the file", "the change as a whole". */
export function describeLocation(location: DraftLocation): string {
  switch (location.kind) {
    case "line":
      return `${location.line.side === "old" ? "old line" : "line"} ${location.line.line}`;
    case "range": {
      const { start, end } = location;
      if (start.side === end.side) return `${start.side === "old" ? "old lines" : "lines"} ${start.line}–${end.line}`;
      return `${describeRef(start)} to ${describeRef(end)}`;
    }
    case "file":
      return "the file";
    case "general":
      return "the change as a whole";
  }
}

function describeRef(ref: LineRef): string {
  return `${ref.side === "old" ? "old line" : "line"} ${ref.line}`;
}
