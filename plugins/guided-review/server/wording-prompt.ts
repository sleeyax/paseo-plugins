import { z } from "zod";
import { describeLocation } from "../shared/drafts.ts";
import type { Guide, GuideNode } from "../shared/guide.ts";
import { nodeContext, type CodeReference } from "./ask-prompt.ts";
import { diffOf, fenced, nodesContext, overviewLines, type CodeSubjectContext, type CommentSubjectContext } from "./comment-subject.ts";
import type { ChangeRequestRef } from "./forge/port.ts";

/** What "Suggest wording" asks the guide agent for: the comment's text, which the panel puts in the box. */
export const WordingSchema = z.object({
  body: z
    .string()
    .min(1)
    .describe("The comment's text, ready to post as the reviewer's own: Markdown, without a greeting, a sign-off or anything around it."),
});

/**
 * The prompt sent to the guide agent for "Suggest wording". The agent wrote the guide earlier in the
 * same conversation, and the reviewer may have asked it about the change since, so the prompt names
 * where the comment goes and the part of the guide it falls in, and leaves the rest to that chat.
 * `typed` is whatever is in the comment box: a rough draft, an instruction, or nothing.
 */
export function wordingPrompt(ref: ChangeRequestRef, headSha: string, subject: CommentSubjectContext, typed: string): string {
  const change = `${ref.url} at ${headSha.slice(0, 12)}`;
  const text = typed.trim();
  return [
    `The reviewer of ${change} is writing a review comment and wants you to word it.`,
    ...subjectContext(ref, subject),
    text === ""
      ? "The reviewer has not typed anything yet. Suggest a short comment a reviewer could leave here: a question about something the code, the description or the commits leave unclear. Do not invent a problem."
      : [
          "What the reviewer typed, as a rough draft or an instruction:",
          fenced(text),
          "Turn it into the comment they mean to post: keep their point, their stance and every question they ask, and make it clear and concise. If they wrote an instruction rather than a draft, follow it.",
        ].join("\n"),
    subject.kind === "code" ? wordingRules(ref) : generalRules(ref),
  ].join("\n\n");
}

function subjectContext(ref: ChangeRequestRef, subject: CommentSubjectContext): string[] {
  switch (subject.kind) {
    case "code":
      return [codeContext(subject), nodesContext(subject.nodes)];
    case "node":
      return [conceptContext(ref, subject.node, subject.code), ...quoteContext(subject.quote)];
    case "overview":
      return [overviewContext(ref, subject.overview, subject.titles), ...quoteContext(subject.quote)];
  }
}

function codeContext({ location, file, lines }: CodeSubjectContext): string {
  const renamed = file.previousPath ? `, renamed from ${file.previousPath}` : "";
  if (location.kind === "file") {
    return `It goes on ${file.path} as a whole, not on any line of it. The file was ${file.status}${renamed}, +${file.additions} −${file.deletions}.`;
  }
  return [
    `It goes on ${describeLocation(location)} of ${file.path}${renamed}. The ${lines.length === 1 ? "line" : "lines"} as the diff shows ${lines.length === 1 ? "it" : "them"}:`,
    diffOf(lines),
  ].join("\n");
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

/** A comment on the change as a whole about the overview, which the prompt gives as the guide has it. */
function overviewContext(ref: ChangeRequestRef, overview: Guide["overview"], titles: ReadonlyMap<string, string>): string {
  const change = ref.forge === "gitlab" ? "merge request" : "pull request";
  return [
    `It goes on the ${change} as a whole, not on any line or file: it is about the overview of your guide, which says:`,
    ...overviewLines(overview, titles),
  ].join("\n");
}

/** The passage of the guide the reviewer highlighted, which only tells the agent what the comment is about. */
function quoteContext(quote: string | null): string[] {
  if (quote === null) return [];
  return [
    [
      "The reviewer highlighted this passage of your guide to comment on:",
      fenced(quote),
      "It is your guide's wording, which nobody reading the review has seen: take it as what the comment is about, and do not quote it.",
    ].join("\n"),
  ];
}

/**
 * The rules for a general comment: those for any comment, but it is read with no code beside it, so
 * it says what it is about first, in the words of the code rather than the guide's.
 */
function generalRules(ref: ChangeRequestRef): string {
  const [forge, where] =
    ref.forge === "gitlab" ? ["GitLab", "as a thread of its own on the merge request"] : ["GitHub", "as a paragraph of the review's summary"];
  return `The comment is posted on ${forge} as the reviewer's own, ${where}, where the author and other reviewers read it with no code beside it. None of them has seen your guide, so it must read correctly without it.
- Open with what the comment is about, named in plain words for what the code does, as in "About the retry handling: …", so it stands on its own.
- Do not use the guide's vocabulary: no trunk, leaf, node or layer, no titles or IDs from the guide, and no mention of the guide or of this chat. Name code by its files, functions and behaviour.
- Word only what the reviewer wants to say. Do not add bugs, security issues, risks, style problems or fixes of your own.
- Write the comment's text only: no greeting, no sign-off and no preamble.
- Do not change anything. Read files in your working directory, the repository at the change's head commit, where the diff alone does not explain something.`;
}
