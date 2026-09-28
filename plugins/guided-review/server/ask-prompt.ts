import type { DiffHunk, FileDiff } from "../shared/diff.ts";
import type { GuideNode } from "../shared/guide.ts";
import type { ChangedFile, ChangeRequestRef } from "./forge/port.ts";

/** Lines of a file on the change's head side (the old side for a removed file), first and last inclusive. */
export type LineRange = { start: number; end: number };

/** A file a node covers, and the parts of it; no ranges means the whole of its change. */
export type CodeReference = { path: string; ranges: readonly LineRange[] };

/**
 * What "Ask about this" asks about, resolved from the stored guide and what the forge said at its
 * head: a node, or a changed file the guide keeps outside its nodes. `category` is the Supporting
 * group's category for the file (test, docs, lockfile, generated, wiring), and null for a file in
 * the Unsorted group, which the guide did not place anywhere.
 */
export type AskSubjectContext =
  | { kind: "node"; node: GuideNode; code: readonly CodeReference[] }
  | { kind: "file"; file: ChangedFile; category: string | null };

/**
 * The code references of a node's resolved `covers`: each file, with the head-side lines of the
 * hunks or runs it covers, or no ranges when it covers the whole of the file's change. A hunk that
 * only removes lines is named by the line after them, where the removal sits in the head.
 */
export function codeReferencesOf(files: readonly FileDiff[]): CodeReference[] {
  return files.map((file) => {
    const whole = file.hunks.length === file.hunkCount && file.hunks.every((hunk) => hunk.complete);
    if (whole) return { path: file.path, ranges: [] };
    const ranges = file.hunks.map((hunk) => headRange(hunk, file.status === "removed")).sort((a, b) => a.start - b.start);
    const merged: LineRange[] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last !== undefined && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    return { path: file.path, ranges: merged };
  });
}

function headRange(hunk: DiffHunk, removed: boolean): LineRange {
  const start = removed ? hunk.oldStart : hunk.newStart;
  const count = removed ? hunk.oldLines : hunk.newLines;
  return count === 0 ? { start: start + 1, end: start + 1 } : { start, end: start + count - 1 };
}

/**
 * The prompt sent to the guide agent when the reviewer asks about `subject`. The agent wrote the
 * guide earlier in the same conversation, so naming the node by its ID and title, with what the
 * guide says about it and the code it covers, is enough for it to know which part is meant.
 */
export function askPrompt(ref: ChangeRequestRef, headSha: string, subject: AskSubjectContext): string {
  const change = `${ref.url} at ${headSha.slice(0, 12)}`;
  const sections =
    subject.kind === "node"
      ? [
          `The reviewer of ${change} wants to understand one concept of your guide better: the node "${subject.node.id}", "${subject.node.title}".`,
          nodeContext(subject.node, subject.code),
          "Explain this concept in more depth than the guide does: how it works in the surrounding code, why it was done this way (using the description, the commits and the linked issues), and how the rest of the change relies on it.",
        ]
      : [
          `The reviewer of ${change} wants to understand one changed file your guide kept outside its concepts: ${subject.file.path}.`,
          fileContext(subject.file, subject.category),
          subject.category === null
            ? "Explain what this file's change does and which part of the change it belongs to."
            : "Explain what this file's change does and how it supports the rest of the change.",
        ];
  return [...sections, ANSWER_RULES].join("\n\n");
}

const ANSWER_RULES = `Answer as a normal message; the reviewer reads it in this chat and will ask follow-up questions here.
- Explain only. Do not report bugs, security issues, risks or style problems, and do not suggest fixes.
- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.
- Do not answer with JSON.`;

/** What the guide says about `node`, and the code it covers, for a prompt that names the node. */
export function nodeContext(node: GuideNode, code: readonly CodeReference[]): string {
  const lines = [`What the guide says about it:`, `- Summary: ${node.summary}`, `- Explanation: ${oneParagraph(node.explanation)}`];
  for (const decision of node.decisions) lines.push(`- Decision: ${decision.choice} Rather than: ${decision.rejected}`);
  if (code.length > 0) {
    lines.push("", "The code it covers:");
    for (const reference of code) lines.push(`- ${reference.path}${rangesOf(reference.ranges)}`);
  }
  return lines.join("\n");
}

function fileContext(file: ChangedFile, category: string | null): string {
  const renamed = file.previousPath ? ` from ${file.previousPath}` : "";
  const placement =
    category === null
      ? "The guide did not place it in any concept or in its Supporting group; it is listed as Unsorted."
      : `The guide lists it under Supporting, as ${category}.`;
  return `The file was ${file.status}${renamed}, +${file.additions} −${file.deletions}. ${placement}`;
}

function rangesOf(ranges: readonly LineRange[]): string {
  if (ranges.length === 0) return "";
  const listed = ranges.map((range) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`));
  return `, ${ranges.length === 1 && ranges[0]!.start === ranges[0]!.end ? "line" : "lines"} ${listed.join(", ")}`;
}

function oneParagraph(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, " ");
}
