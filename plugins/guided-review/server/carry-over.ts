import type { FileDiff } from "../shared/diff.ts";
import type { LayeredGuide } from "../shared/guide.ts";
import type { Understood } from "../shared/progress.ts";
import { fileDiffOf, resolveCode } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";

/** A guide with the changed files it was written from, as the forge gave them at its head. */
export type GuideAtHead = { guide: LayeredGuide; files: readonly ChangedFile[] };

/**
 * The reviewer's marks in `previous` that still hold in `next`, a guide of the same review at a later
 * head: a node of `next` is understood when the code it covers is exactly the code a node understood
 * in `previous` covers, whatever either node is called, and a Supporting or Unsorted entry of `next`
 * is understood when it was in `previous` and its diff did not change. Marks come back in `next`'s order.
 *
 * Code is compared by its lines, not by hunk numbers or line numbers: a push that adds a hunk above
 * renumbers the hunks and lines below it without changing what they say.
 */
export function carryMarks(previous: GuideAtHead & { marks: Understood }, next: GuideAtHead): Understood {
  const marked = new Set(previous.marks.nodes);
  const understoodCode = new Set(
    previous.guide.nodes
      .filter((node) => marked.has(node.id))
      .flatMap((node) => keyOf(resolveCode(previous.files, node.covers).files) ?? []),
  );
  const nodes = next.guide.nodes
    .filter((node) => {
      const key = keyOf(resolveCode(next.files, node.covers).files);
      return key !== null && understoodCode.has(key);
    })
    .map((node) => node.id);

  const markedFiles = new Set(previous.marks.files);
  const before = new Map(previous.files.map((file) => [file.path, file]));
  const outside = [...next.guide.supporting.map((entry) => entry.path), ...next.guide.unsorted];
  const files = outside.filter((path) => {
    const was = before.get(path);
    const now = next.files.find((file) => file.path === path);
    if (!markedFiles.has(path) || was === undefined || now === undefined) return false;
    const key = keyOf([fileDiffOf(now)]);
    return key !== null && key === keyOf([fileDiffOf(was)]);
  });

  return { nodes, files };
}

/**
 * The node of `next` that covers exactly the code the node `nodeId` of `previous` covers, compared
 * as `carryMarks` compares them; null when there is none, or nothing to compare. How a draft written
 * from a node of an earlier guide finds its node in a later one.
 */
export function followNode(previous: GuideAtHead, nodeId: string, next: GuideAtHead): string | null {
  const node = previous.guide.nodes.find((candidate) => candidate.id === nodeId);
  const key = node === undefined ? null : keyOf(resolveCode(previous.files, node.covers).files);
  if (key === null) return null;
  return next.guide.nodes.find((candidate) => keyOf(resolveCode(next.files, candidate.covers).files) === key)?.id ?? null;
}

/**
 * What a subject's code says, as one string two subjects share only when their code is the same:
 * each file by path, with its lines' kinds and text. Null when there is nothing to compare, which
 * includes a file whose diff the forge withheld, since a binary or oversized change cannot be told
 * apart from the one before it.
 */
function keyOf(files: readonly FileDiff[]): string | null {
  if (files.length === 0 || files.some((file) => file.withheld)) return null;
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(
    sorted.map((file) => [
      file.path,
      file.previousPath,
      file.status,
      file.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text, line.noNewlineAtEnd])),
    ]),
  );
}
