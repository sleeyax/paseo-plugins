import type { ForeignWork } from "../shared/foreign-work.ts";
import { numberLabel } from "../shared/reference.ts";
import { splitHunks } from "./diff.ts";
import type { ChangedFile, ChangeRequest } from "./forge/port.ts";

/** A file's diff past this is left for the agent to read in the checkout, so one file cannot crowd out the rest. */
export const MAX_PATCH_CHARS = 40_000;

/**
 * The prompt the guide agent writes the guide from: the rules, then everything the forge said about
 * the change. The output schema is appended by the caller.
 *
 * `changeRequest.files` is what the agent is to place; `setAside` counts the lockfiles and generated
 * files the caller kept from it, which are only mentioned so the size line does not mislead.
 * `ownWork` is the foreign work of a guide of the change request's own work alone, whose commits
 * are left out, and `foreignFiles` counts the files only they change, which the caller kept too.
 */
export function guidePrompt(changeRequest: ChangeRequest, setAside = 0, ownWork: { foreign: ForeignWork; foreignFiles: number } | null = null): string {
  const { ref } = changeRequest;
  const kind = ref.forge === "gitlab" ? "merge request" : "pull request";
  const foreign = new Set(ownWork?.foreign.changeRequests.flatMap((other) => other.commits) ?? []);
  const commits = changeRequest.commits.filter((commit) => !foreign.has(commit.sha));
  const others = ownWork?.foreign.changeRequests.map((other) => numberLabel(ref.forge, other.number)).join(", ") ?? "";
  const sections = [
    `You are the guide agent for a code review. Write a guide to ${ref.url} that explains the change to a reviewer in the order it should be understood.`,
    RULES,
    ...(ownWork === null
      ? []
      : [
          `This guide is of the ${kind}'s own work only. Its branch also carries the commits of ${others}, which its target does not have yet; they are reviewed there, so they are left out of the commits below, and so are the files only they change. A file below may still hold some of their changes: place those like the rest.`,
        ]),
    `# The ${kind}`,
    [
      `Title: ${changeRequest.title}`,
      `Repository: ${ref.project}`,
      `Author: ${changeRequest.author.login}`,
      `Branches: ${changeRequest.headBranch} into ${changeRequest.baseBranch}`,
      `Head commit: ${changeRequest.headSha}`,
      `Size: ${changeRequest.files.length} files, +${changeRequest.additions} −${changeRequest.deletions}`,
    ].join("\n"),
    "## Description",
    changeRequest.description.trim() || "(none)",
    "## Commits",
    commits.length === 0
      ? "(none)"
      : commits
          .map((commit) => {
            const body = commit.body.trim();
            return `- ${commit.sha.slice(0, 7)} ${commit.headline}${body ? `\n${indent(body)}` : ""}`;
          })
          .join("\n"),
    "## Linked issues",
    changeRequest.linkedIssues.length === 0
      ? "(none)"
      : changeRequest.linkedIssues
          .map((issue) => {
            const body = issue.body.trim();
            return `- #${issue.number} ${issue.title} (${issue.state.toLowerCase()})${body ? `\n${indent(body)}` : ""}`;
          })
          .join("\n"),
    "## Changed files",
    [
      ...changeRequest.files.map(describeFile),
      ...(setAside > 0
        ? [`(${setAside} lockfile or generated ${setAside === 1 ? "file is" : "files are"} left out: they are placed already.)`]
        : []),
      ...(ownWork !== null && ownWork.foreignFiles > 0
        ? [`(${ownWork.foreignFiles} ${ownWork.foreignFiles === 1 ? "file" : "files"} only ${others} ${ownWork.foreignFiles === 1 ? "changes is" : "change are"} left out: they are placed already.)`]
        : []),
    ].join("\n"),
    "## Diff",
    ...changeRequest.files.map(fileDiff),
  ];
  return sections.join("\n\n");
}

const RULES = `Rules:
- Explain only. Do not report bugs, security issues, risks or style problems, and do not suggest fixes or improvements: another reviewer covers those, and this guide must not duplicate or contradict it.
- Do not change anything. Do not edit or write files, and do not run commands. Your working directory is the repository checked out at the change's head commit; read and search files there with your file tools when the diff alone does not explain something.
- Split the change into concepts ("nodes"): a node is a named group of changes, possibly spanning several files, that does one thing. List the foundations first and the code built on them after.
- Reviewers read this guide instead of the diff, and open the code only to dig deeper. Describe why the change exists, using the description, the commits and the linked issues, and what it does, but not how its lines do it.
- The overview's idea is two or three sentences. Each need-to-know is one new invariant, contract or concept that spans more than one node; a fact about one node goes in that node instead. Each decision names what the author chose. Give its alternative only when the description, a commit message, a linked issue or an added line of the diff names the alternative the author rejected, and quote those words exactly; otherwise leave it null. Never guess an alternative: one whose quote is not found in those texts is dropped.
- Attention names the one or two foundational nodes that matter most, by their id.
- A node's summary is one line. Its \`why\` is one or two sentences on why the concept exists. Its \`behaviour\` lists what it does, one short fact per entry, so a reviewer who skips its code misses nothing they need: when it runs, what it reads and writes, side effects, every other place in the repository that uses what changed, and names and limits that matter after merge. Never narrate how the lines achieve it, and never repeat the summary or a need-to-know.
- Before saying what uses a changed name, search the checkout for it and name every file that does. When changed code runs a script, action or function from the repository, read it and say what it does beyond its purpose: services it starts, files it writes, network it reaches.
- Keep a behaviour entry only if a reviewer would misunderstand the change, or judge it differently, without it. A setting that matches what the rest of the repository already does is boilerplate, whatever the language or platform (runner images, checkout and setup steps, ordinary timeouts, defaults): mention one only when it departs from the norm or is the point of the change. Leave out ids, secret names, names nothing refers to and what stays unchanged.
- Before answering, reread every behaviour entry against the rule above and delete those that fail it.
- A node lists only the decisions whose rejected alternative the author names, quoted as for the overview. A choice with no such alternative goes in \`why\` or \`behaviour\` if it matters, and a node's decision without a quoted alternative is dropped. A decision about one node goes on that node; the overview's decisions are only those that span several, and an overview decision with the quote of a node's decision is dropped.
- Write the text of the guide as prose with inline Markdown only: backticks around code, identifiers and paths, and \`**\` or \`*\` for emphasis. The panel draws nothing else, so use no headings, lists, links, tables or code blocks; separate paragraphs with a blank line.
- A node's dependencies name the earlier nodes it builds on. Give a dependency's reason only when the two titles do not make it obvious why that node comes first; otherwise leave it null. A node may depend only on nodes listed before it. Foundations depend on nothing; keep the tree to about three layers.
- A node's \`covers\` names the code it explains, one entry per file: the file's path, and the numbers of the hunks it covers as the diff below labels them ("Hunk 2"). Leave \`hunks\` and \`lines\` empty when the node covers all of the file. When one hunk holds more than one concept, give line ranges in \`lines\` instead, so each node shows only its own lines. Several nodes may cover different hunks of one file.
- Tests, docs and pure wiring (exports, registration, configuration that only connects the rest) go in supporting, not in a node.
- Place every file under "Changed files": cover some or all of it in a node, or list it in supporting. Use the paths exactly as listed.`;

function describeFile(file: ChangedFile): string {
  const renamed = file.previousPath ? ` from ${file.previousPath}` : "";
  return `- ${file.path} (${file.status}${renamed}, +${file.additions} −${file.deletions})`;
}

/**
 * A file's diff hunk by hunk, each labelled with the number a node's `covers` names it by. A diff
 * too large to include is still listed by its headers, so its hunks can be named.
 */
function fileDiff(file: ChangedFile): string {
  const heading = `### ${file.path}`;
  if (file.patch === null) {
    return `${heading}\n\n(No diff: the file is binary, or too large for the forge to show. Read it in the repository, and cover it whole: leave \`hunks\` and \`lines\` empty, since there are none to name.)`;
  }
  const hunks = splitHunks(file.patch);
  if (file.patch.length > MAX_PATCH_CHARS) {
    const headers = hunks.map((hunk, index) => `- Hunk ${index + 1}: ${hunk.split("\n", 1)[0]}`);
    return [`${heading}\n\n(The diff is too large to include here. Read the file in the repository. Its hunks:)`, ...headers].join("\n");
  }
  return [heading, ...hunks.map((hunk, index) => `Hunk ${index + 1}:\n\n${fenced(hunk)}`)].join("\n\n");
}

function fenced(diff: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(diff) + 1));
  return `${fence}diff\n${diff}\n${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
