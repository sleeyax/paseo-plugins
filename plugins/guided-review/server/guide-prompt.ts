import type { ForeignWork } from "../shared/foreign-work.ts";
import { numberLabel } from "../shared/reference.ts";
import type { ChangeRequest } from "./forge/port.ts";

/**
 * The prompt the guide agent writes the guide from: the rules, what only the forge knows about the
 * change, and the commands that read the rest from the checkout. The output schema is appended by
 * the caller.
 *
 * The agent reads the commits, the changed files and their diffs with git, between the base and head
 * commits, which the caller makes sure the checkout has; that keeps the prompt the same size however
 * large the change. `setAside` names the lockfiles and generated files the caller places itself.
 * `ownWork` is the foreign work of a guide of the change request's own work alone, whose commits and
 * files are read from its `ownFrom` on.
 */
export function guidePrompt(changeRequest: ChangeRequest, setAside: readonly string[] = [], ownWork: ForeignWork | null = null): string {
  const { ref, baseSha, headSha } = changeRequest;
  const kind = ref.forge === "gitlab" ? "merge request" : "pull request";
  const others = ownWork?.changeRequests.map((other) => numberLabel(ref.forge, other.number)).join(", ") ?? "";
  const ownBase = ownWork?.ownFrom ? `${ownWork.ownFrom}^1` : null;
  const sections = [
    `You are the guide agent for a code review. Write a guide to ${ref.url} that explains the change to a reviewer in the order it should be understood.`,
    RULES,
    ...(ownBase === null
      ? []
      : [
          `This guide is of the ${kind}'s own work only. Its branch also carries the commits of ${others}, which its target does not have yet; they are reviewed there, so the commits and the file list below leave them out. A file in the list may still hold some of their changes: place those like the rest.`,
        ]),
    `# The ${kind}`,
    [
      `Title: ${changeRequest.title}`,
      `Repository: ${ref.project}`,
      `Author: ${changeRequest.author.login}`,
      `Branches: ${changeRequest.headBranch} into ${changeRequest.baseBranch}`,
      `Base commit: ${baseSha}`,
      `Head commit: ${headSha}`,
      `Size: ${changeRequest.files.length} files, +${changeRequest.additions} −${changeRequest.deletions}`,
    ].join("\n"),
    "## Description",
    changeRequest.description.trim() || "(none)",
    "## Linked issues",
    changeRequest.linkedIssues.length === 0
      ? "(none)"
      : changeRequest.linkedIssues
          .map((issue) => {
            const body = issue.body.trim();
            return `- #${issue.number} ${issue.title} (${issue.state.toLowerCase()})${body ? `\n${indent(body)}` : ""}`;
          })
          .join("\n"),
    "## Reading the change",
    [
      `- The commits: \`git log ${ownBase ?? baseSha}..${headSha}\``,
      `- The file list: \`git diff --name-status -M ${ownBase === null ? `${baseSha}...${headSha}` : `${ownBase} ${headSha}`}\``,
      `- A file's hunks, which \`covers\` numbers: \`git diff --no-ext-diff --no-color --diff-algorithm=myers -U3 --inter-hunk-context=${INTER_HUNK_CONTEXT[ref.forge]} -M ${baseSha}...${headSha} -- <path>\`, naming both paths for a renamed file, the old one first. Keep these options, or the hunks may be cut differently from the forge's.`,
    ].join("\n"),
    ...(setAside.length > 0
      ? ["## Placed already", `These lockfiles and generated files are placed already: do not read or cover them.\n${setAside.map((path) => `- ${path}`).join("\n")}`]
      : []),
  ];
  return sections.join("\n\n");
}

const RULES = `Rules:
- Explain only. Do not report bugs, security issues, risks or style problems, and do not suggest fixes or improvements: another reviewer covers those, and this guide must not duplicate or contradict it.
- Do not change anything. Do not edit or write files. Your working directory is the repository checked out at the change's head commit. Read the change there with the commands under "Reading the change", and read and search files with your file tools or with commands that only read, like \`git log\`, \`git diff\`, \`git show\`, \`ls\`, \`rg\` or \`find\`: no redirects into files, and quote globs. A command that would change anything is refused.
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
- A node's \`covers\` names the code it explains, one entry per file: the file's path, and the numbers of the hunks it covers, counting the \`@@\` headers of the file's diff from 1 as the hunk command under "Reading the change" prints it. Leave \`hunks\` and \`lines\` empty when the node covers all of the file. When one hunk holds more than one concept, give line ranges in \`lines\` instead, so each node shows only its own lines. Several nodes may cover different hunks of one file.
- Tests, docs and pure wiring (exports, registration, configuration that only connects the rest) go in supporting, not in a node.
- Place every file the file list under "Reading the change" names, except those placed already: cover some or all of it in a node, or list it in supporting. Use the paths exactly as the list gives them, the new path for a renamed file.`;

/** How far apart two changes may be for each forge to show them as one hunk, which git leaves to the host's config: measured against the forges' own patches. */
const INTER_HUNK_CONTEXT = { github: 1, gitlab: 0 } as const;

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
