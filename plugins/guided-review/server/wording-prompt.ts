import { z } from "zod";
import type { DiffLine } from "../shared/diff.ts";
import { describeLocation, type DraftLocation } from "../shared/drafts.ts";
import { coveredPaths, type GuideNode } from "../shared/guide.ts";
import { anchorAt } from "./anchors.ts";
import { parsePatch, resolveCode } from "./diff.ts";
import type { ChangedFile, ChangeRequestRef } from "./forge/port.ts";
import { nodeContext, type CodeReference } from "./ask-prompt.ts";

/** What "Suggest wording" asks the guide agent for: the comment's text, which the panel puts in the box. */
export const WordingSchema = z.object({
  body: z
    .string()
    .min(1)
    .describe("The comment's text, ready to post as the reviewer's own: Markdown, without a greeting, a sign-off or anything around it."),
});

/**
 * What the wording prompt says about where the comment goes, resolved from the stored guide and what
 * the forge said at its head. A comment on code names its file, the lines it is on (none for the
 * file as a whole) and the guide's nodes whose covers include any of them, usually one and often none.
 * A node's comment, on the change as a whole, names the node and the code it covers.
 */
export type WordingSubjectContext = CodeWordingContext | { kind: "node"; node: GuideNode; code: readonly CodeReference[] };

export type CodeWordingContext = {
  kind: "code";
  location: DraftLocation;
  file: ChangedFile;
  lines: readonly DiffLine[];
  nodes: readonly GuideNode[];
};

/**
 * The context of a comment at `location`: its lines, looked up in the diff at the review's head, and
 * the nodes that cover them. Throws, in a sentence for the panel, when a comment cannot go there.
 */
export function codeWordingContext(files: readonly ChangedFile[], nodes: readonly GuideNode[], location: DraftLocation): CodeWordingContext {
  if (location.kind === "general") throw new Error("A comment on the change as a whole is a node's comment; suggest its wording from the node.");
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

/**
 * The prompt sent to the guide agent for "Suggest wording". The agent wrote the guide earlier in the
 * same conversation, and the reviewer may have asked it about the change since, so the prompt names
 * where the comment goes and the part of the guide it falls in, and leaves the rest to that chat.
 * `typed` is whatever is in the comment box: a rough draft, an instruction, or nothing.
 */
export function wordingPrompt(ref: ChangeRequestRef, headSha: string, subject: WordingSubjectContext, typed: string): string {
  const change = `${ref.url} at ${headSha.slice(0, 12)}`;
  const text = typed.trim();
  return [
    `The reviewer of ${change} is writing a review comment and wants you to word it.`,
    ...(subject.kind === "code" ? [codeContext(subject), nodesContext(subject.nodes)] : [conceptContext(ref, subject.node, subject.code)]),
    text === ""
      ? "The reviewer has not typed anything yet. Suggest a short comment a reviewer could leave here: a question about something the code, the description or the commits leave unclear. Do not invent a problem."
      : [
          "What the reviewer typed, as a rough draft or an instruction:",
          fenced(text),
          "Turn it into the comment they mean to post: keep their point, their stance and every question they ask, and make it clear and concise. If they wrote an instruction rather than a draft, follow it.",
        ].join("\n"),
    subject.kind === "code" ? wordingRules(ref) : conceptRules(ref),
  ].join("\n\n");
}

function codeContext({ location, file, lines }: CodeWordingContext): string {
  const renamed = file.previousPath ? `, renamed from ${file.previousPath}` : "";
  if (location.kind === "file") {
    return `It goes on ${file.path} as a whole, not on any line of it. The file was ${file.status}${renamed}, +${file.additions} −${file.deletions}.`;
  }
  const marker = { added: "+", removed: "-", context: " " } as const;
  const diff = lines.map((line) => `${marker[line.kind]}${line.text}`).join("\n");
  return [
    `It goes on ${describeLocation(location)} of ${file.path}${renamed}. The ${lines.length === 1 ? "line" : "lines"} as the diff shows ${lines.length === 1 ? "it" : "them"}:`,
    fenced(diff, "diff"),
  ].join("\n");
}

function nodesContext(nodes: readonly GuideNode[]): string {
  if (nodes.length === 0) return "Your guide does not place this code in any of its nodes.";
  const heading = nodes.length === 1 ? "The node of your guide this code falls in:" : "The nodes of your guide this code falls in:";
  return [heading, ...nodes.map((node) => `- "${node.id}", "${node.title}": ${node.summary}`)].join("\n");
}

function wordingRules(ref: ChangeRequestRef): string {
  const forge = ref.forge === "gitlab" ? "GitLab" : "GitHub";
  return `The comment is posted on ${forge} as the reviewer's own, where the author and other reviewers read it beside the code. None of them has seen your guide, so it must read correctly without it.
- Do not use the guide's vocabulary: no trunk, leaf, node or layer, no titles or IDs from the guide, and no mention of the guide or of this chat. Name code by its files, functions and behaviour.
- Word only what the reviewer wants to say. Do not add bugs, security issues, risks, style problems or fixes of your own.
- Write the comment's text only: no greeting, no sign-off, no preamble, and no file or line the comment's position already gives.
- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.`;
}

/** A node's comment: on the change as a whole, about one concept of it, which the prompt names as the guide has it. */
function conceptContext(ref: ChangeRequestRef, node: GuideNode, code: readonly CodeReference[]): string {
  const change = ref.forge === "gitlab" ? "merge request" : "pull request";
  return [
    `It goes on the ${change} as a whole, not on any line or file: it is about one concept of the change, the node "${node.id}", "${node.title}" of your guide.`,
    nodeContext(node, code),
  ].join("\n");
}

/**
 * The rules for a node's comment: those for any comment, but it is read with no code beside it, so
 * it says what it is about first, in the words of the code rather than the guide's.
 */
function conceptRules(ref: ChangeRequestRef): string {
  const [forge, where] =
    ref.forge === "gitlab" ? ["GitLab", "as a thread of its own on the merge request"] : ["GitHub", "as a paragraph of the review's summary"];
  return `The comment is posted on ${forge} as the reviewer's own, ${where}, where the author and other reviewers read it with no code beside it. None of them has seen your guide, so it must read correctly without it.
- Open with what the comment is about, named in plain words for what the code does, as in "About the retry handling: …", so it stands on its own.
- Do not use the guide's vocabulary: no trunk, leaf, node or layer, no titles or IDs from the guide, and no mention of the guide or of this chat. Name code by its files, functions and behaviour.
- Word only what the reviewer wants to say. Do not add bugs, security issues, risks, style problems or fixes of your own.
- Write the comment's text only: no greeting, no sign-off and no preamble.
- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.`;
}

/** `text` in a Markdown fence long enough that nothing inside closes it. */
function fenced(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
