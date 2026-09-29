import { z } from "zod";

/**
 * A file's diff as the panel draws it: parsed on the server, so the client only lays lines out. Every
 * line keeps what a draft anchored on it needs, on either forge: its kind and its old and new numbers
 * for GitHub's side and line, and GitLab's running counters for a `line_code`.
 */

/** A run of a line's text and the syntax role Paseo's highlighter gave it, null for none. */
export const SyntaxTokenSchema = z.object({ text: z.string(), style: z.string().nullable() });

export const DiffLineSchema = z.object({
  kind: z.enum(["added", "removed", "context"]),
  /** The line without its `+`, `-` or space. */
  text: z.string(),
  /** The line's number in the old file; null for an added line. */
  oldLine: z.number().int().nullable(),
  /** The line's number in the new file; null for a removed line. */
  newLine: z.number().int().nullable(),
  /**
   * GitLab's running counters at this line, as its diff parser keeps them: the old and the new line
   * number the hunk has reached. They equal `oldLine` and `newLine` where those are set; an added
   * line's `oldPos` is the next old line and a removed line's `newPos` the next new line. A GitLab
   * `line_code` is `sha1(path)_oldPos_newPos`.
   */
  oldPos: z.number().int(),
  newPos: z.number().int(),
  /** The diff marks this line "\ No newline at end of file". */
  noNewlineAtEnd: z.boolean(),
  /** The line's text cut into syntax tokens; absent where the language is not one Paseo highlights. */
  tokens: z.array(SyntaxTokenSchema).optional(),
});

export const DiffHunkSchema = z.object({
  /** The hunk's number in its file, from 1, as the guide agent was shown it. */
  index: z.number().int(),
  /** Where the lines shown start and how many there are, as a `@@ -oldStart,oldLines +newStart,newLines @@` header gives them. */
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** The text after the header's closing `@@`, usually the enclosing function; empty when there is none. */
  section: z.string(),
  /**
   * False when a node covers only some of the hunk's lines: these are one unbroken run of them, and
   * the header describes the run. A node that covers two runs of one hunk has two entries with its index.
   */
  complete: z.boolean(),
  lines: z.array(DiffLineSchema),
});

export const FileDiffSchema = z.object({
  path: z.string(),
  /** Where a renamed or copied file came from. */
  previousPath: z.string().nullable(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** The forge gave no diff: the file is binary, too large to show, or renamed without changes. */
  withheld: z.boolean(),
  /** How many hunks the whole file has, of which `hunks` are the ones shown. */
  hunkCount: z.number().int(),
  hunks: z.array(DiffHunkSchema),
});

export type DiffLineKind = z.output<typeof DiffLineSchema>["kind"];
export type DiffLine = z.output<typeof DiffLineSchema>;
export type SyntaxToken = z.output<typeof SyntaxTokenSchema>;
export type DiffHunk = z.output<typeof DiffHunkSchema>;
export type FileDiff = z.output<typeof FileDiffSchema>;
