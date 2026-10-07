import type { DiffHunk, DiffLine } from "../shared/diff.ts";
import { describeLocation, isLine, type DraftLocation, type LineRef } from "../shared/drafts.ts";
import { parsePatch } from "./diff.ts";
import type { AnchorLine, ChangedFile, DraftAnchor } from "./forge/port.ts";

/**
 * The anchor a draft at `location` goes on, looked up in the diff the panel drew it from: the lines
 * it names with everything either forge anchors them by. Throws, in a sentence for the panel, when
 * the location is not somewhere a forge can put a comment.
 *
 * A range must stay within one hunk, which GitHub requires; its ends may come in either order, and
 * a range of one line is that line. A `general` location is on no file, so there is nothing to look up.
 */
export function anchorAt(files: readonly ChangedFile[], location: DraftLocation): DraftAnchor {
  if (location.kind === "general") return { kind: "general" };
  const file = files.find((candidate) => candidate.path === location.path);
  if (file === undefined) throw new Error(`${location.path} is not one of the change's files.`);
  const at = { path: file.path, previousPath: file.previousPath };
  if (location.kind === "file") return { kind: "file", ...at };

  const hunks = file.patch === null ? [] : parsePatch(file.patch);
  const find = (ref: LineRef) => {
    for (const hunk of hunks) {
      const index = hunk.lines.findIndex((line) => isLine(line, ref));
      if (index !== -1) return { hunk, index };
    }
    const where = describeLocation({ kind: "line", path: file.path, line: ref });
    throw new Error(`${where[0]!.toUpperCase()}${where.slice(1)} of ${file.path} is not in the diff, so a comment cannot be anchored there.`);
  };

  if (location.kind === "line") {
    const { hunk, index } = find(location.line);
    return { kind: "line", ...at, line: anchorLine(hunk, index) };
  }
  let start = find(location.start);
  let end = find(location.end);
  if (start.hunk !== end.hunk) throw new Error("A comment on several lines has to stay within one hunk of the diff.");
  if (start.index > end.index) [start, end] = [end, start];
  if (start.index === end.index) return { kind: "line", ...at, line: anchorLine(start.hunk, start.index) };
  return { kind: "range", ...at, start: anchorLine(start.hunk, start.index), end: anchorLine(end.hunk, end.index) };
}

function anchorLine(hunk: DiffHunk, index: number): AnchorLine {
  const { kind, oldLine, newLine, oldPos, newPos }: DiffLine = hunk.lines[index]!;
  return { kind, oldLine, newLine, oldPos, newPos };
}
