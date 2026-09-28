import type { DiffHunk, DiffLine, FileDiff } from "../shared/diff.ts";
import type { CoveredCode } from "../shared/guide.ts";
import type { ChangedFile } from "./forge/port.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * A patch cut at each `@@` header, one hunk's text per entry. Anything before the first header is
 * not part of a hunk; the forges start their patches at one, so there is nothing there.
 */
export function splitHunks(patch: string): string[] {
  const hunks: string[][] = [];
  for (const line of withoutFinalNewline(patch).split("\n")) {
    if (HUNK_HEADER.test(line)) hunks.push([line]);
    else hunks.at(-1)?.push(line);
  }
  return hunks.map((lines) => lines.join("\n"));
}

/**
 * The hunks of a file's unified diff, with every line's old and new number. The counters run the
 * way GitLab's own diff parser runs them, from the header's starts, so `oldPos` and `newPos` make
 * the `line_code` GitLab expects: a `\ No newline at end of file` marks the line before it and moves
 * neither.
 */
export function parsePatch(patch: string): DiffHunk[] {
  return splitHunks(patch).map((text, position) => {
    const [header, ...body] = text.split("\n");
    const match = HUNK_HEADER.exec(header!)!;
    const oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    let oldPos = oldStart;
    let newPos = newStart;
    const lines: DiffLine[] = [];
    for (const raw of body) {
      const marker = raw[0];
      if (marker === "\\") {
        const previous = lines.at(-1);
        if (previous) previous.noNewlineAtEnd = true;
        continue;
      }
      const text = raw.slice(1);
      if (marker === "+") {
        lines.push({ kind: "added", text, oldLine: null, newLine: newPos, oldPos, newPos, noNewlineAtEnd: false });
        newPos += 1;
      } else if (marker === "-") {
        lines.push({ kind: "removed", text, oldLine: oldPos, newLine: null, oldPos, newPos, noNewlineAtEnd: false });
        oldPos += 1;
      } else {
        // A context line; one whose leading space an editor or a copy stripped is still one.
        lines.push({ kind: "context", text: marker === " " ? text : raw, oldLine: oldPos, newLine: newPos, oldPos, newPos, noNewlineAtEnd: false });
        oldPos += 1;
        newPos += 1;
      }
    }
    return {
      index: position + 1,
      oldStart,
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart,
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      section: match[5]!.trim(),
      complete: true,
      lines,
    };
  });
}

/** The whole of a changed file's diff. */
export function fileDiffOf(file: ChangedFile): FileDiff {
  const hunks = file.patch === null ? [] : parsePatch(file.patch);
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    withheld: file.patch === null,
    hunkCount: hunks.length,
    hunks,
  };
}

export type ResolvedCode = {
  /** One entry per file, in the order the code first names them, each with the hunks it covers. */
  files: FileDiff[];
  /** What the code names that the diff does not have, as `path: message` lines under `covers`. */
  errors: string[];
};

/**
 * The diff a node's `covers` names, cut down to the hunks and lines it lists. A file named twice is
 * shown once, with everything both entries cover; what does not exist is left out and reported.
 */
export function resolveCode(changed: readonly ChangedFile[], covers: readonly CoveredCode[]): ResolvedCode {
  const byPath = new Map(changed.map((file) => [file.path, file]));
  const selected = new Map<string, { diff: FileDiff; whole: Set<number>; lines: Map<number, Set<number>> }>();
  const errors: string[] = [];

  covers.forEach((cover, coverIndex) => {
    const at = `covers.${coverIndex}`;
    const file = byPath.get(cover.path);
    if (file === undefined) {
      errors.push(`${at}.path: "${cover.path}" is not one of the changed files`);
      return;
    }
    let entry = selected.get(cover.path);
    if (entry === undefined) {
      entry = { diff: fileDiffOf(file), whole: new Set(), lines: new Map() };
      selected.set(cover.path, entry);
    }
    const { diff, whole, lines } = entry;

    if (cover.hunks.length === 0 && cover.lines.length === 0) {
      for (const hunk of diff.hunks) whole.add(hunk.index);
      return;
    }
    cover.hunks.forEach((index, position) => {
      if (index >= 1 && index <= diff.hunkCount) whole.add(index);
      else errors.push(`${at}.hunks.${position}: ${cover.path} has ${describeCount(diff.hunkCount)}, so no hunk ${index}`);
    });
    // A removed file has only old line numbers; everywhere else a range is in the new file's.
    const numberOf = diff.status === "removed" ? (line: DiffLine) => line.oldPos : (line: DiffLine) => line.newLine ?? line.newPos;
    cover.lines.forEach((range, position) => {
      if (range.start > range.end) {
        errors.push(`${at}.lines.${position}: the range ${range.start}–${range.end} ends before it starts`);
        return;
      }
      let found = false;
      for (const hunk of diff.hunks) {
        hunk.lines.forEach((line, lineIndex) => {
          const number = numberOf(line);
          if (number < range.start || number > range.end) return;
          found = true;
          let chosen = lines.get(hunk.index);
          if (chosen === undefined) lines.set(hunk.index, (chosen = new Set()));
          chosen.add(lineIndex);
        });
      }
      if (!found) errors.push(`${at}.lines.${position}: lines ${range.start}–${range.end} are not in the diff of ${cover.path}`);
    });
  });

  const files = [...selected.values()].map(({ diff, whole, lines }) => ({
    ...diff,
    hunks: diff.hunks.flatMap((hunk) => {
      if (whole.has(hunk.index)) return [hunk];
      const chosen = lines.get(hunk.index);
      if (chosen === undefined) return [];
      return chosen.size === hunk.lines.length ? [hunk] : [slice(hunk, [...chosen].sort((a, b) => a - b))];
    }),
  }));
  return { files, errors };
}

/** Part of a hunk, with a header that describes the lines it keeps the way git would write it. */
function slice(hunk: DiffHunk, indices: readonly number[]): DiffHunk {
  const lines = indices.map((index) => hunk.lines[index]!);
  const oldLines = lines.filter((line) => line.oldLine !== null).length;
  const newLines = lines.filter((line) => line.newLine !== null).length;
  const first = lines[0]!;
  // An empty side starts at the line before, as in `@@ -0,0 +1,3 @@`; a hunk whose side was empty
  // already has its counter there.
  const emptyStart = (pos: number, side: number, start: number) => (side === 0 ? start : pos - 1);
  return {
    ...hunk,
    oldStart: oldLines === 0 ? emptyStart(first.oldPos, hunk.oldLines, hunk.oldStart) : first.oldPos,
    oldLines,
    newStart: newLines === 0 ? emptyStart(first.newPos, hunk.newLines, hunk.newStart) : first.newPos,
    newLines,
    complete: false,
    lines,
  };
}

function describeCount(count: number): string {
  return count === 0 ? "no hunks" : count === 1 ? "1 hunk" : `${count} hunks`;
}

function withoutFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
