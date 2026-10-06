import type { CommentSubject } from "../shared/contracts.ts";
import type { DiffHunk, DiffLine, FileDiff } from "../shared/diff.ts";
import type { DraftLocation } from "../shared/drafts.ts";
import { coveredPaths, type Guide, type GuideDecision, type GuideNode, type LayeredGuide } from "../shared/guide.ts";
import { anchorAt } from "./anchors.ts";
import { entryCode, parsePatch, resolveCode } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";

/**
 * What a comment box is on, resolved from the stored guide and what the forge said at its head, for
 * the prompts of "Suggest wording" and "Ask agent". Code names its file, the lines (none for the file
 * as a whole) and the guide's nodes whose covers include any of them, usually one and often none. A
 * whole file also names where the guide put it, when that is Supporting or Unsorted. A
 * general comment, on the change as a whole, names the node and the code it covers, or the overview
 * with the node titles its attention entries point at, and the passage of either the reviewer highlighted.
 */
export type CommentSubjectContext =
  | CodeSubjectContext
  | { kind: "node"; node: GuideNode; code: readonly CodeReference[]; quote: string | null }
  | { kind: "overview"; overview: Guide["overview"]; titles: ReadonlyMap<string, string>; quote: string | null };

export type CodeSubjectContext = {
  kind: "code";
  location: DraftLocation;
  file: ChangedFile;
  lines: readonly DiffLine[];
  nodes: readonly GuideNode[];
  /** Where the guide put the file, for the file as a whole; null for lines, or a file only nodes cover. */
  placement: FilePlacement | null;
};

/**
 * A file's entry in Supporting, with its category, or in Unsorted, where `category` is null. `rest`
 * is set for a file some nodes cover part of: the head-side lines of what the entry holds.
 */
export type FilePlacement = { category: string | null; rest: readonly LineRange[] | null };

/** The context of `subject` in `guide`. Throws, in a sentence for the panel, when it is not there. */
export function commentSubjectContext(
  files: readonly ChangedFile[],
  guide: Pick<LayeredGuide, "nodes" | "overview" | "supporting" | "unsorted">,
  subject: CommentSubject,
): CommentSubjectContext {
  switch (subject.kind) {
    case "node": {
      const node = guide.nodes.find((candidate) => candidate.id === subject.nodeId);
      if (node === undefined) throw new Error("That concept is not in the guide any more.");
      const code = codeReferencesOf(resolveCode(files, node.covers).files);
      return { kind: "node", node, code, quote: subject.quote?.trim() || null };
    }
    case "overview": {
      const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
      return { kind: "overview", overview: guide.overview, titles, quote: subject.quote?.trim() || null };
    }
    case "code":
      return codeSubjectContext(files, guide, subject.location);
  }
}

/**
 * The context of code at `location`: its lines, looked up in the diff at the review's head, and the
 * nodes that cover them. Throws, in a sentence for the panel, when a comment cannot go there.
 */
export function codeSubjectContext(
  files: readonly ChangedFile[],
  guide: Pick<LayeredGuide, "nodes" | "supporting" | "unsorted">,
  location: DraftLocation,
): CodeSubjectContext {
  if (location.kind === "general") throw new Error("A comment on the change as a whole is about a node or the overview, not about code.");
  const { nodes } = guide;
  const anchor = anchorAt(files, location);
  const file = files.find((candidate) => candidate.path === location.path)!;
  if (anchor.kind === "file" || anchor.kind === "general") {
    const covering = nodes.filter((node) => coveredPaths(node).includes(file.path));
    return { kind: "code", location, file, lines: [], nodes: covering, placement: placementOf(files, guide, file.path, covering.length > 0) };
  }

  const [first, last] = anchor.kind === "line" ? [anchor.line, anchor.line] : [anchor.start, anchor.end];
  const same = (a: Pick<DiffLine, "oldLine" | "newLine">, b: Pick<DiffLine, "oldLine" | "newLine">) =>
    a.oldLine === b.oldLine && a.newLine === b.newLine;
  let lines: DiffLine[] = [];
  for (const hunk of parsePatch(file.patch!)) {
    const start = hunk.lines.findIndex((line) => same(line, first));
    if (start === -1) continue;
    lines = hunk.lines.slice(start, hunk.lines.findIndex((line) => same(line, last)) + 1);
    break;
  }
  const covering = nodes.filter((node) =>
    resolveCode(files, node.covers)
      .files.filter((diff) => diff.path === file.path)
      .some((diff) => diff.hunks.some((hunk) => hunk.lines.some((line) => lines.some((anchored) => same(line, anchored))))),
  );
  return { kind: "code", location, file, lines, nodes: covering, placement: null };
}

function placementOf(
  files: readonly ChangedFile[],
  guide: Pick<LayeredGuide, "nodes" | "supporting" | "unsorted">,
  path: string,
  partlyCovered: boolean,
): FilePlacement | null {
  const supporting = guide.supporting.find((entry) => entry.path === path);
  const category = supporting !== undefined ? supporting.category : guide.unsorted.includes(path) ? null : undefined;
  if (category === undefined) return null;
  return { category, rest: partlyCovered ? codeReferencesOf([entryCode(files, guide.nodes, path)!])[0]!.ranges : null };
}

/** Where the guide put a file asked or commented on as a whole, as a sentence or two; empty for a file only nodes cover. */
export function placementSentences(path: string, placement: FilePlacement | null): string {
  if (placement === null) return "";
  const where =
    placement.category === null
      ? " Your guide did not place it in any node or in its Supporting group; it lists it as Unsorted."
      : placement.category === "foreign"
        ? " Your guide explains only this change request's own work, which does not change it: only other change requests' commits it carries do, so you were not shown it."
        : ` Your guide lists it under Supporting, as ${placement.category}.`;
  if (placement.rest === null) return where;
  return `${where} What it lists there is the part no node covers: ${path}${rangesOf(placement.rest)}.`;
}

/** `lines` as the diff shows them, fenced. */
export function diffOf(lines: readonly DiffLine[]): string {
  const marker = { added: "+", removed: "-", context: " " } as const;
  return fenced(lines.map((line) => `${marker[line.kind]}${line.text}`).join("\n"), "diff");
}

export function nodesContext(nodes: readonly GuideNode[]): string {
  if (nodes.length === 0) return "Your guide does not place this code in any of its nodes.";
  const heading = nodes.length === 1 ? "The node of your guide this code falls in:" : "The nodes of your guide this code falls in:";
  return [heading, ...nodes.map((node) => `- "${node.id}", "${node.title}": ${node.summary}`)].join("\n");
}

/** What the overview says, a line per part, for a prompt about it. */
export function overviewLines(overview: Guide["overview"], titles: ReadonlyMap<string, string>): string[] {
  const lines = [`- Idea: ${oneLine(overview.idea)}`];
  for (const item of overview.needToKnows) lines.push(`- Need to know: ${oneLine(item)}`);
  for (const decision of overview.decisions) lines.push(decisionLine(decision));
  for (const entry of overview.attention) lines.push(`- Where to spend attention: "${titles.get(entry.nodeId) ?? entry.nodeId}": ${entry.reason}`);
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text` in a Markdown fence long enough that nothing inside closes it. */
export function fenced(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Lines of a file on the change's head side (the old side for a removed file), first and last inclusive. */
export type LineRange = { start: number; end: number };

/** A file a node covers, and the parts of it; no ranges means the whole of its change. */
export type CodeReference = { path: string; ranges: readonly LineRange[] };

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

/** The rules for an answer the reviewer reads in the agent's chat, with `scope` saying what it may cover. */
export function answerRules(scope: string): string {
  return `Answer as a normal message; the reviewer reads it in this chat and will ask follow-up questions here.
- ${scope}
- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.
- Do not answer with JSON.`;
}

/** What the guide says about `node`, and the code it covers, for a prompt that names the node. */
export function nodeContext(node: GuideNode, code: readonly CodeReference[]): string {
  const lines = [`What the guide says about it:`, `- Summary: ${node.summary}`, `- Why: ${oneParagraph(node.why)}`];
  for (const fact of node.behaviour) lines.push(`- What it does: ${oneParagraph(fact)}`);
  for (const decision of node.decisions) lines.push(decisionLine(decision));
  if (code.length > 0) {
    lines.push("", "The code it covers:");
    for (const reference of code) lines.push(`- ${reference.path}${rangesOf(reference.ranges)}`);
  }
  return lines.join("\n");
}

function rangesOf(ranges: readonly LineRange[]): string {
  if (ranges.length === 0) return "";
  const listed = ranges.map((range) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`));
  return `, ${ranges.length === 1 && ranges[0]!.start === ranges[0]!.end ? "line" : "lines"} ${listed.join(", ")}`;
}

function oneParagraph(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, " ");
}

/** A decision as a prompt lists it, with the alternative only where the author's words back one; a guide from before alternatives needed a quote has none. */
export function decisionLine(decision: GuideDecision): string {
  return decision.alternative ? `- Decision: ${decision.choice} Rather than: ${decision.alternative.text}` : `- Decision: ${decision.choice}`;
}
