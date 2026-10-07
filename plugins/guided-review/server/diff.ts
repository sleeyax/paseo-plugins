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

/** The lines of a file's diff that covers pick, by hunk index, as indices into each hunk's lines. */
type Selection = Map<number, Set<number>>;

/**
 * The diff a node's `covers` names, cut down to the hunks and lines it lists. A file named twice is
 * shown once, with everything both entries cover; what does not exist is left out and reported.
 */
export function resolveCode(changed: readonly ChangedFile[], covers: readonly CoveredCode[]): ResolvedCode {
  const byPath = new Map(changed.map((file) => [file.path, file]));
  const selected = new Map<string, { diff: FileDiff; selection: Selection }>();
  const errors: string[] = [];

  covers.forEach((cover, coverIndex) => {
    const file = byPath.get(cover.path);
    if (file === undefined) {
      errors.push(`covers.${coverIndex}.path: "${cover.path}" is not one of the changed files`);
      return;
    }
    let entry = selected.get(cover.path);
    if (entry === undefined) {
      entry = { diff: fileDiffOf(file), selection: new Map() };
      selected.set(cover.path, entry);
    }
    select(entry.diff, cover, entry.selection, (error) => errors.push(`covers.${coverIndex}.${error}`));
  });

  const files = [...selected.values()].map(({ diff, selection }) => ({
    ...diff,
    hunks: diff.hunks.flatMap((hunk) => {
      const chosen = selection.get(hunk.index);
      if (chosen === undefined) return [];
      return chosen.size === hunk.lines.length ? [hunk] : runs([...chosen].sort((a, b) => a - b)).map((run) => slice(hunk, run));
    }),
  }));
  return { files, errors };
}

/**
 * What of a changed file's diff none of `covers` takes: the file's whole diff when no cover names it,
 * otherwise each unbroken run of lines left over that changes more than whitespace, cut as
 * `resolveCode` cuts a node's. Null when a cover names the file and nothing it changes is left,
 * which is also how a withheld file some cover names reads. What a Supporting or Unsorted entry of a
 * file some node covers part of shows, so no change in it goes unshown.
 */
export function uncoveredCode(file: ChangedFile, covers: readonly CoveredCode[]): FileDiff | null {
  return leftover(file, covers, changesText);
}

/**
 * The code a Supporting or Unsorted entry of `guide` shows for the changed file `path`: what no node
 * covers of it. Its whole diff when every change in it is a node's, which only a guide laid out
 * before partly covered files had entries can hold. Null when the change has no such file.
 * A guide laid out before blank leftovers stopped counting can list a file whose only leftovers are blank lines, and shows those.
 */
export function entryCode(changed: readonly ChangedFile[], nodes: readonly { covers: readonly CoveredCode[] }[], path: string): FileDiff | null {
  const file = changed.find((candidate) => candidate.path === path);
  if (file === undefined) return null;
  const covers = nodes.flatMap((node) => node.covers);
  return uncoveredCode(file, covers) ?? leftover(file, covers, (line) => line.kind !== "context") ?? fileDiffOf(file);
}

/** An added or removed line with more than whitespace on it: a blank line left between the ranges a node covers is nothing to review. */
function changesText(line: DiffLine): boolean {
  return line.kind !== "context" && line.text.trim() !== "";
}

/** What of `file` none of `covers` takes, keeping only the untouched hunks and the leftover runs that hold a line `counts`. */
function leftover(file: ChangedFile, covers: readonly CoveredCode[], counts: (line: DiffLine) => boolean): FileDiff | null {
  const diff = fileDiffOf(file);
  const own = covers.filter((cover) => cover.path === file.path);
  if (own.length === 0) return diff;
  const selection: Selection = new Map();
  for (const cover of own) select(diff, cover, selection, () => {});
  const hunks = diff.hunks.flatMap((hunk) => {
    const taken = selection.get(hunk.index);
    if (taken === undefined) return hunk.lines.some(counts) ? [hunk] : [];
    const left = hunk.lines.map((_, index) => index).filter((index) => !taken.has(index));
    return runs(left)
      .filter((run) => run.some((index) => counts(hunk.lines[index]!)))
      .map((run) => slice(hunk, run));
  });
  return hunks.length === 0 ? null : { ...diff, hunks };
}

/**
 * Adds the lines of `diff` that `cover` names to `selection`: every hunk for a cover with neither
 * hunks nor lines, else the hunks it lists whole and the lines its ranges take. What the diff lacks
 * goes to `error` as `field: message`.
 */
function select(diff: FileDiff, cover: CoveredCode, selection: Selection, error: (message: string) => void): void {
  const take = (hunk: DiffHunk, indices: Iterable<number>) => {
    let chosen = selection.get(hunk.index);
    if (chosen === undefined) selection.set(hunk.index, (chosen = new Set()));
    for (const index of indices) chosen.add(index);
  };
  const whole = (hunk: DiffHunk) => take(hunk, hunk.lines.keys());

  if (cover.hunks.length === 0 && cover.lines.length === 0) {
    diff.hunks.forEach(whole);
    return;
  }
  cover.hunks.forEach((index, position) => {
    const hunk = diff.hunks[index - 1];
    if (index >= 1 && hunk !== undefined) whole(hunk);
    else error(`hunks.${position}: ${cover.path} has ${describeCount(diff.hunkCount)}, so no hunk ${index}`);
  });
  // A removed file has only old line numbers; everywhere else a range is in the new file's.
  const numberOf = diff.status === "removed" ? (line: DiffLine) => line.oldPos : (line: DiffLine) => line.newLine ?? line.newPos;
  cover.lines.forEach((range, position) => {
    if (range.start > range.end) {
      error(`lines.${position}: the range ${range.start}–${range.end} ends before it starts`);
      return;
    }
    let found = false;
    for (const hunk of diff.hunks) {
      hunk.lines.forEach((line, lineIndex) => {
        const number = numberOf(line);
        if (number < range.start || number > range.end) return;
        found = true;
        take(hunk, [lineIndex]);
      });
    }
    if (!found) error(`lines.${position}: lines ${range.start}–${range.end} are not in the diff of ${cover.path}`);
  });
}

/** Sorted line indices in unbroken runs, so lines a node skips show as a gap between two parts of a hunk. */
function runs(indices: readonly number[]): number[][] {
  const result: number[][] = [];
  for (const index of indices) {
    const last = result.at(-1);
    if (last !== undefined && last.at(-1) === index - 1) last.push(index);
    else result.push([index]);
  }
  return result;
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
