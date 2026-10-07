import assert from "node:assert/strict";
import test from "node:test";
import type { FileDiff, SyntaxToken } from "../shared/diff.ts";
import { DiffHighlighter } from "./diff-highlight.ts";
import { fileDiffOf } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";

/** A comment edited below its opening line, which a hunk alone does not show. */
const COMMENT_EDIT: ChangedFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -2,2 +2,2 @@\n- * old\n+ * new\n  */\n",
};
const BASE = "/*\n * old\n */\nconst a = 1;\n";
const HEAD = "/*\n * new\n */\nconst a = 1;\n";

function files(entries: Record<string, string>) {
  const shown: string[] = [];
  return {
    shown,
    fileAt: async (sha: string, path: string) => {
      shown.push(`${sha}:${path}`);
      return entries[`${sha}:${path}`] ?? null;
    },
  };
}

async function highlighted(file: ChangedFile, entries: Record<string, string>): Promise<FileDiff> {
  const [diff] = await new DiffHighlighter().highlight("review:head", [fileDiffOf(file)], [file], { baseSha: "base", headSha: "head", ...files(entries) });
  return diff!;
}

const styles = (tokens: readonly SyntaxToken[] | undefined) => tokens?.map((token) => token.style);

test("highlights each side from the whole file, so a comment opened above the hunk colours its lines", async () => {
  const [removed, added, context] = (await highlighted(COMMENT_EDIT, { "base:src/a.ts": BASE, "head:src/a.ts": HEAD })).hunks[0]!.lines;
  assert.deepEqual(removed!.tokens, [{ text: " * old", style: "comment" }]);
  assert.deepEqual(added!.tokens, [{ text: " * new", style: "comment" }]);
  assert.deepEqual(context!.tokens, [{ text: " */", style: "comment" }]);
});

test("falls back to the hunks' own text where a side's file is missing or does not match the diff", async () => {
  const [removed, added] = (await highlighted(COMMENT_EDIT, { "base:src/a.ts": HEAD, "head:src/a.ts": HEAD })).hunks[0]!.lines;
  assert.equal(styles(removed!.tokens)?.includes("comment"), false);
  assert.deepEqual(added!.tokens, [{ text: " * new", style: "comment" }]);
  const alone = (await highlighted(COMMENT_EDIT, {})).hunks[0]!.lines;
  assert.ok(alone.every((line) => line.tokens !== undefined && line.tokens.map((token) => token.text).join("") === line.text));
});

test("reads a renamed file's old side at its previous path, and an added file's at no base", async () => {
  const renamed = { ...COMMENT_EDIT, status: "renamed" as const, previousPath: "src/old.ts" };
  const reads = files({ "base:src/old.ts": BASE, "head:src/a.ts": HEAD });
  await new DiffHighlighter().highlight("review:head", [fileDiffOf(renamed)], [renamed], { baseSha: "base", headSha: "head", ...reads });
  assert.deepEqual(reads.shown.sort(), ["base:src/old.ts", "head:src/a.ts"]);

  const added: ChangedFile = { ...COMMENT_EDIT, status: "added", patch: "@@ -0,0 +1,1 @@\n+const b = 2;\n" };
  const addedReads = files({});
  await new DiffHighlighter().highlight("review:head", [fileDiffOf(added)], [added], { baseSha: "base", headSha: "head", ...addedReads });
  assert.deepEqual(addedReads.shown, ["head:src/a.ts"]);
});

test("leaves a language Paseo does not highlight, and a withheld diff, without tokens", async () => {
  const notes = await highlighted({ ...COMMENT_EDIT, path: "notes.unknownext" }, {});
  assert.ok(notes.hunks[0]!.lines.every((line) => line.tokens === undefined));
  const withheld = await highlighted({ ...COMMENT_EDIT, patch: null }, {});
  assert.deepEqual(withheld.hunks, []);
});

test("reads a file once for every node that shows it", async () => {
  const highlighter = new DiffHighlighter();
  const reads = files({ "base:src/a.ts": BASE, "head:src/a.ts": HEAD });
  const sides = { baseSha: "base", headSha: "head", ...reads };
  await highlighter.highlight("review:head", [fileDiffOf(COMMENT_EDIT)], [COMMENT_EDIT], sides);
  await highlighter.highlight("review:head", [fileDiffOf(COMMENT_EDIT)], [COMMENT_EDIT], sides);
  assert.equal(reads.shown.length, 2);
});
