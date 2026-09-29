import { describeLocation } from "../shared/drafts.ts";
import { answerRules, nodeContext } from "./ask-prompt.ts";
import { diffOf, fenced, nodesContext, overviewLines, type CodeSubjectContext, type CommentSubjectContext } from "./comment-subject.ts";
import type { ChangeRequestRef } from "./forge/port.ts";

/**
 * The prompt sent to the guide agent for "Ask agent": the reviewer's own question about what the
 * comment box is on. The agent wrote the guide earlier in the same conversation, so the prompt names
 * that part of the change as the wording prompt does, and the reviewer follows up in the chat.
 */
export function questionPrompt(ref: ChangeRequestRef, headSha: string, subject: CommentSubjectContext, question: string): string {
  return [
    `The reviewer of ${ref.url} at ${headSha.slice(0, 12)} has a question for you.`,
    ...subjectContext(subject),
    ["Their question:", fenced(question.trim())].join("\n"),
    answerRules("Answer the question they asked. Do not raise bugs, security issues, risks, style problems or fixes they did not ask about."),
  ].join("\n\n");
}

function subjectContext(subject: CommentSubjectContext): string[] {
  switch (subject.kind) {
    case "code":
      return [codeContext(subject), nodesContext(subject.nodes)];
    case "node":
      return [
        [`It is about one concept of the change, the node "${subject.node.id}", "${subject.node.title}" of your guide.`, nodeContext(subject.node, subject.code)].join("\n"),
        ...quoteContext(subject.quote),
      ];
    case "overview":
      return [["It is about the overview of your guide, which says:", ...overviewLines(subject.overview, subject.titles)].join("\n"), ...quoteContext(subject.quote)];
  }
}

function codeContext({ location, file, lines }: CodeSubjectContext): string {
  const renamed = file.previousPath ? `, renamed from ${file.previousPath}` : "";
  if (location.kind === "file") {
    return `It is about ${file.path} as a whole. The file was ${file.status}${renamed}, +${file.additions} −${file.deletions}.`;
  }
  return [
    `It is about ${describeLocation(location)} of ${file.path}${renamed}. The ${lines.length === 1 ? "line" : "lines"} as the diff shows ${lines.length === 1 ? "it" : "them"}:`,
    diffOf(lines),
  ].join("\n");
}

function quoteContext(quote: string | null): string[] {
  return quote === null ? [] : [["The reviewer highlighted this passage of your guide to ask about:", fenced(quote)].join("\n")];
}
