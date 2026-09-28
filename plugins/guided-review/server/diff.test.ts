import assert from "node:assert/strict";
import test from "node:test";
import type { DiffLine } from "../shared/diff.ts";
import { fileDiffOf, parsePatch, resolveCode, splitHunks } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";

/** A line as `kind old new oldPos newPos`, which is what a hunk's numbering comes down to. */
function numbering(lines: readonly DiffLine[]): string[] {
  return lines.map((line) => `${line.kind} ${line.oldLine ?? "-"} ${line.newLine ?? "-"} ${line.oldPos}_${line.newPos}${line.noNewlineAtEnd ? " eof" : ""}`);
}

function changed(path: string, patch: string | null, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, previousPath: null, status: "modified", additions: 0, deletions: 0, patch, ...overrides };
}

test("numbers every line of every hunk, and keeps GitLab's running counters beside the numbers", () => {
  const hunks = parsePatch(
    [
      "@@ -7,6 +7,7 @@ func main() {",
      " a",
      " b",
      "+c",
      " d",
      "-e",
      "-f",
      "+g",
      " h",
      "@@ -40,3 +41,2 @@",
      " x",
      "-y",
      " z",
    ].join("\n"),
  );

  assert.deepEqual(
    hunks.map(({ index, oldStart, oldLines, newStart, newLines, section, complete }) => ({ index, oldStart, oldLines, newStart, newLines, section, complete })),
    [
      { index: 1, oldStart: 7, oldLines: 6, newStart: 7, newLines: 7, section: "func main() {", complete: true },
      { index: 2, oldStart: 40, oldLines: 3, newStart: 41, newLines: 2, section: "", complete: true },
    ],
  );
  assert.deepEqual(numbering(hunks[0]!.lines), [
    "context 7 7 7_7",
    "context 8 8 8_8",
    "added - 9 9_9",
    "context 9 10 9_10",
    "removed 10 - 10_11",
    "removed 11 - 11_11",
    "added - 11 12_11",
    "context 12 12 12_12",
  ]);
  assert.deepEqual(numbering(hunks[1]!.lines), ["context 40 41 40_41", "removed 41 - 41_42", "context 42 42 42_42"]);
  assert.deepEqual(
    hunks[0]!.lines.map((line) => line.text),
    ["a", "b", "c", "d", "e", "f", "g", "h"],
  );
});

test("a missing newline at the end marks the line before it and moves no counter", () => {
  const [hunk] = parsePatch(["@@ -1,2 +1,2 @@", " one", "-two", "\\ No newline at end of file", "+two", "\\ No newline at end of file"].join("\n"));

  assert.deepEqual(numbering(hunk!.lines), ["context 1 1 1_1", "removed 2 - 2_2 eof", "added - 2 3_2 eof"]);
});

test("reads headers that leave a count of one out, and a new or removed file's empty side", () => {
  const [single] = parsePatch("@@ -3 +3 @@\n-a\n+b");
  assert.deepEqual([single!.oldStart, single!.oldLines, single!.newStart, single!.newLines], [3, 1, 3, 1]);

  // GitLab starts the old counter of a new file at the header's 0, so its line codes read `_0_n`.
  const [added] = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.deepEqual(numbering(added!.lines), ["added - 1 0_1", "added - 2 0_2"]);

  const [removed] = parsePatch("@@ -1,2 +0,0 @@\n-a\n-b");
  assert.deepEqual(numbering(removed!.lines), ["removed 1 - 1_0", "removed 2 - 2_0"]);
});

test("a context line an editor stripped of its space is still a context line", () => {
  const [hunk] = parsePatch("@@ -1,3 +1,3 @@\n a\n\n+c\n-b");
  assert.deepEqual(numbering(hunk!.lines), ["context 1 1 1_1", "context 2 2 2_2", "added - 3 3_3", "removed 3 - 3_4"]);
  assert.equal(hunk!.lines[1]!.text, "");
});

test("splits a patch into its hunks' text, for the prompt to number them", () => {
  assert.deepEqual(splitHunks("@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@ fn\n-c\n+d\n"), ["@@ -1 +1 @@\n-a\n+b", "@@ -9 +9 @@ fn\n-c\n+d"]);
  assert.deepEqual(splitHunks(""), []);
});

test("a file the forge gave no diff for is withheld and has no hunks", () => {
  assert.deepEqual(fileDiffOf(changed("logo.png", null, { status: "renamed", previousPath: "old/logo.png" })), {
    path: "logo.png",
    previousPath: "old/logo.png",
    status: "renamed",
    additions: 0,
    deletions: 0,
    withheld: true,
    hunkCount: 0,
    hunks: [],
  });
});

const TWO_HUNKS = changed("src/a.ts", "@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -20,4 +21,3 @@\n w\n-x\n y\n z", { additions: 1, deletions: 1 });
const NEW_FILE = changed("src/new.ts", "@@ -0,0 +1,6 @@\n+1\n+2\n+3\n+4\n+5\n+6", { status: "added", additions: 6 });
const GONE = changed("src/gone.ts", "@@ -1,3 +0,0 @@\n-1\n-2\n-3", { status: "removed", deletions: 3 });
const CHANGED = [TWO_HUNKS, NEW_FILE, GONE];

test("covers a whole file, or only the hunks a node names", () => {
  const whole = resolveCode(CHANGED, [{ path: "src/a.ts", hunks: [], lines: [] }]);
  assert.deepEqual(whole.errors, []);
  assert.deepEqual(whole.files.map((file) => file.hunks.map((hunk) => hunk.index)), [[1, 2]]);

  const second = resolveCode(CHANGED, [{ path: "src/a.ts", hunks: [2], lines: [] }]);
  assert.equal(second.files[0]!.hunkCount, 2);
  assert.deepEqual(second.files[0]!.hunks, [parsePatch(TWO_HUNKS.patch!)[1]]);
});

test("a line range cuts a hunk down, with a header for the lines it keeps", () => {
  const { files, errors } = resolveCode(CHANGED, [{ path: "src/new.ts", hunks: [], lines: [{ start: 3, end: 4 }] }]);

  assert.deepEqual(errors, []);
  const [hunk] = files[0]!.hunks;
  assert.deepEqual([hunk!.oldStart, hunk!.oldLines, hunk!.newStart, hunk!.newLines, hunk!.complete], [0, 0, 3, 2, false]);
  assert.deepEqual(numbering(hunk!.lines), ["added - 3 0_3", "added - 4 0_4"]);
});

test("a removed line goes with the new line after it, and a removed file's ranges are old line numbers", () => {
  const replaced = resolveCode(CHANGED, [{ path: "src/a.ts", hunks: [], lines: [{ start: 22, end: 22 }] }]);
  assert.deepEqual(numbering(replaced.files[0]!.hunks[0]!.lines), ["removed 21 - 21_22", "context 22 22 22_22"]);
  assert.deepEqual(
    [replaced.files[0]!.hunks[0]!.oldStart, replaced.files[0]!.hunks[0]!.oldLines, replaced.files[0]!.hunks[0]!.newStart, replaced.files[0]!.hunks[0]!.newLines],
    [21, 2, 22, 1],
  );

  const gone = resolveCode(CHANGED, [{ path: "src/gone.ts", hunks: [], lines: [{ start: 2, end: 3 }] }]);
  assert.deepEqual(numbering(gone.files[0]!.hunks[0]!.lines), ["removed 2 - 2_0", "removed 3 - 3_0"]);
});

test("a file named twice is shown once with everything both entries cover, in the order first named", () => {
  const { files, errors } = resolveCode(CHANGED, [
    { path: "src/new.ts", hunks: [], lines: [{ start: 1, end: 1 }] },
    { path: "src/a.ts", hunks: [2], lines: [] },
    { path: "src/new.ts", hunks: [], lines: [{ start: 2, end: 6 }] },
  ]);

  assert.deepEqual(errors, []);
  assert.deepEqual(
    files.map((file) => file.path),
    ["src/new.ts", "src/a.ts"],
  );
  assert.equal(files[0]!.hunks[0]!.complete, true, "every line of the hunk is covered, so it is the whole hunk");
});

test("names what a node covers that the diff does not have, and leaves it out", () => {
  const { files, errors } = resolveCode(CHANGED, [
    { path: "src/missing.ts", hunks: [], lines: [] },
    { path: "src/a.ts", hunks: [3], lines: [{ start: 100, end: 120 }, { start: 5, end: 4 }] },
  ]);

  assert.deepEqual(errors, [
    'covers.0.path: "src/missing.ts" is not one of the changed files',
    "covers.1.hunks.0: src/a.ts has 2 hunks, so no hunk 3",
    "covers.1.lines.0: lines 100–120 are not in the diff of src/a.ts",
    "covers.1.lines.1: the range 5–4 ends before it starts",
  ]);
  assert.deepEqual(files.map((file) => [file.path, file.hunks.length]), [["src/a.ts", 0]]);
});
