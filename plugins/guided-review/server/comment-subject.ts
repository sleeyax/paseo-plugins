import type { CommentSubject } from "../shared/contracts.ts";
import type { DiffLine } from "../shared/diff.ts";
import type { DraftLocation } from "../shared/drafts.ts";
import { coveredPaths, type Guide, type GuideNode } from "../shared/guide.ts";
import { anchorAt } from "./anchors.ts";
import { codeReferencesOf, decisionLine, type CodeReference } from "./ask-prompt.ts";
import { parsePatch, resolveCode } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";

/**
 * What a comment box is on, resolved from the stored guide and what the forge said at its head, for
 * the prompts of "Suggest wording" and "Ask agent". Code names its file, the lines (none for the file
 * as a whole) and the guide's nodes whose covers include any of them, usually one and often none. A
 * general comment, on the change as a whole, names the node and the code it covers, or the overview
 * with the node titles its attention entries point at, and the passage of either the reviewer highlighted.
 */
export type CommentSubjectContext =
  | CodeSubjectContext
  | { kind: "node"; node: GuideNode; code: readonly CodeReference[]; quote: string | null }
  | { kind: "overview"; overview: Guide["overview"]; titles: ReadonlyMap<string, string>; quote: string };

export type CodeSubjectContext = {
  kind: "code";
  location: DraftLocation;
  file: ChangedFile;
  lines: readonly DiffLine[];
  nodes: readonly GuideNode[];
};

/** The context of `subject` in `guide`. Throws, in a sentence for the panel, when it is not there. */
export function commentSubjectContext(files: readonly ChangedFile[], guide: Pick<Guide, "nodes" | "overview">, subject: CommentSubject): CommentSubjectContext {
  switch (subject.kind) {
    case "node": {
      const node = guide.nodes.find((candidate) => candidate.id === subject.nodeId);
      if (node === undefined) throw new Error("That concept is not in the guide any more.");
      const code = codeReferencesOf(resolveCode(files, node.covers).files);
      return { kind: "node", node, code, quote: subject.quote?.trim() || null };
    }
    case "overview": {
      const titles = new Map(guide.nodes.map((node) => [node.id, node.title]));
      return { kind: "overview", overview: guide.overview, titles, quote: subject.quote.trim() };
    }
    case "code":
      return codeSubjectContext(files, guide.nodes, subject.location);
  }
}

/**
 * The context of code at `location`: its lines, looked up in the diff at the review's head, and the
 * nodes that cover them. Throws, in a sentence for the panel, when a comment cannot go there.
 */
export function codeSubjectContext(files: readonly ChangedFile[], nodes: readonly GuideNode[], location: DraftLocation): CodeSubjectContext {
  if (location.kind === "general") throw new Error("A comment on the change as a whole is about a node or the overview, not about code.");
  const anchor = anchorAt(files, location);
  const file = files.find((candidate) => candidate.path === location.path)!;
  if (anchor.kind === "file" || anchor.kind === "general") {
    return { kind: "code", location, file, lines: [], nodes: nodes.filter((node) => coveredPaths(node).includes(file.path)) };
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
  return { kind: "code", location, file, lines, nodes: covering };
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
