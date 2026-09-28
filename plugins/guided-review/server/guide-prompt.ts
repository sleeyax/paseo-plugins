import type { ChangedFile, ChangeRequest } from "./forge/port.ts";

/** A file's diff past this is left for the agent to read in the checkout, so one file cannot crowd out the rest. */
export const MAX_PATCH_CHARS = 40_000;

/**
 * The prompt the guide agent writes the guide from: the rules, then everything the forge said about
 * the change. The output schema is appended by the caller.
 *
 * `changeRequest.files` is what the agent is to place; `setAside` counts the lockfiles and generated
 * files the caller kept from it, which are only mentioned so the size line does not mislead.
 */
export function guidePrompt(changeRequest: ChangeRequest, setAside = 0): string {
  const { ref } = changeRequest;
  const sections = [
    `You are the guide agent for a code review. Write a guide to ${ref.url} that explains the change to a reviewer in the order it should be understood.`,
    RULES,
    `# The ${ref.forge === "gitlab" ? "merge request" : "pull request"}`,
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
    changeRequest.commits.length === 0
      ? "(none)"
      : changeRequest.commits
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
    ].join("\n"),
    "## Diff",
    ...changeRequest.files.map(fileDiff),
  ];
  return sections.join("\n\n");
}

const RULES = `Rules:
- Explain only. Do not report bugs, security issues, risks or style problems, and do not suggest fixes or improvements: another reviewer covers those, and this guide must not duplicate or contradict it.
- Do not change anything. Do not edit or write files, and do not run commands. Your working directory is the repository checked out at the change's head commit; read files there when the diff alone does not explain something.
- Split the change into concepts ("nodes"): a node is a named group of changes, possibly spanning several files, that does one thing. List the foundations first and the code built on them after.
- Describe why the change exists and how it works, using the description, the commits and the linked issues, not just what the lines say.
- The overview's idea is two or three sentences. Each need-to-know is one new invariant, contract or concept. Each decision names what the author chose and the alternative they plausibly rejected.
- Attention names the one or two foundational nodes that matter most, by their id.
- A node's summary is one line; its explanation is a short paragraph or two.
- A node's dependencies name the earlier nodes it builds on, each with the reason it has to be understood first. A node may depend only on nodes listed before it. Foundations depend on nothing; keep the tree to about three layers.
- Tests, docs and pure wiring (exports, registration, configuration that only connects the rest) go in supporting, not in a node.
- Place every file under "Changed files" exactly once: in the files of one node, or in supporting. Use the paths exactly as listed.`;

function describeFile(file: ChangedFile): string {
  const renamed = file.previousPath ? ` from ${file.previousPath}` : "";
  return `- ${file.path} (${file.status}${renamed}, +${file.additions} −${file.deletions})`;
}

function fileDiff(file: ChangedFile): string {
  const heading = `### ${file.path}`;
  if (file.patch === null) return `${heading}\n\n(No diff: the file is binary, or too large for the forge to show. Read it in the repository.)`;
  if (file.patch.length > MAX_PATCH_CHARS) return `${heading}\n\n(The diff is too large to include here. Read the file in the repository.)`;
  const fence = "`".repeat(Math.max(3, longestBacktickRun(file.patch) + 1));
  return `${heading}\n\n${fence}diff\n${file.patch}\n${fence}`;
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
