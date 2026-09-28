import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeCommandRunner, type FakeCommandRunner, type ScriptedResult } from "../fake-command-runner.ts";
import {
  ADD_THREAD_MUTATION,
  createGitHubForge,
  DELETE_COMMENT_MUTATION,
  DRAFTS_QUERY,
  PENDING_REVIEW_QUERY,
  PULL_REQUEST_QUERY,
  START_REVIEW_MUTATION,
  UPDATE_COMMENT_MUTATION,
} from "./github.ts";
import { ForgeError, type AnchorLine, type ChangeRequestRef, type DraftAnchor, type DraftTarget } from "./port.ts";

/** Recorded from `gh` 2.101 against sleeyax/paseo-plugins#105; the user is trimmed to its public fields. */
function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", "github", name), "utf8");
}

const GH = "/opt/gh/bin/gh";

function forgeReplaying(script: readonly ScriptedResult[]) {
  const run = fakeCommandRunner(script);
  return { run, forge: createGitHubForge({ run, gh: async () => GH }) };
}

const PR_105: ChangeRequestRef = {
  forge: "github",
  host: "github.com",
  project: "sleeyax/paseo-plugins",
  number: 105,
  url: "https://github.com/sleeyax/paseo-plugins/pull/105",
};

test("takes a pull request URL however it was copied", async () => {
  const { forge } = forgeReplaying([]);
  for (const url of [
    "https://github.com/sleeyax/paseo-plugins/pull/105",
    "  https://github.com/sleeyax/paseo-plugins/pull/105/files  ",
    "https://www.github.com/sleeyax/paseo-plugins/pull/105#discussion_r1",
    "http://github.com/sleeyax/paseo-plugins/pull/105?w=1",
    "github.com/sleeyax/paseo-plugins/pull/105",
  ]) {
    assert.deepEqual(await forge.matchUrl(url), PR_105, url);
  }
});

test("turns down anything that is not a GitHub pull request", async () => {
  const { forge, run } = forgeReplaying([]);
  for (const url of [
    "",
    "not a url",
    "https://github.com/sleeyax/paseo-plugins",
    "https://github.com/sleeyax/paseo-plugins/issues/90",
    "https://github.com/sleeyax/paseo-plugins/pulls",
    "https://github.com/sleeyax/paseo-plugins/pull/0",
    "https://github.com/sleeyax/paseo-plugins/pull/abc",
    "https://github.com/../etc/pull/1",
    "https://gitlab.com/group/project/-/merge_requests/1",
    "https://example.com/sleeyax/paseo-plugins/pull/105",
    "ftp://github.com/sleeyax/paseo-plugins/pull/105",
  ]) {
    assert.equal(await forge.matchUrl(url), null, url);
  }
  assert.deepEqual(run.calls, [], "matching a URL runs nothing");
});

test("reads a pull request's metadata, commits, linked issues and files through gh", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("pull-request.json") }, { stdout: fixture("files.json") }]);

  const pr = await forge.fetchChangeRequest(PR_105);

  assert.deepEqual(
    run.calls.map((call) => ({ file: call.file, args: call.args, input: call.input && JSON.parse(call.input) })),
    [
      {
        file: GH,
        args: ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        input: { query: PULL_REQUEST_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
      },
      {
        file: GH,
        args: ["api", "--hostname", "github.com", "repos/sleeyax/paseo-plugins/pulls/105/files?per_page=100", "--paginate"],
        input: undefined,
      },
    ],
  );
  for (const call of run.calls) assert.equal(call.env?.GH_PROMPT_DISABLED, "1");

  assert.equal(pr.ref, PR_105);
  assert.equal(pr.title, "chore: build the plugins against Paseo SDK 0.9.2");
  assert.match(pr.description, /^Closes #89\./);
  assert.deepEqual(pr.author, { login: "sleeyax", name: "Sleeyax" });
  assert.equal(pr.state, "merged");
  assert.equal(pr.isDraft, false);
  assert.deepEqual(
    { baseBranch: pr.baseBranch, headBranch: pr.headBranch, baseSha: pr.baseSha, startSha: pr.startSha, headSha: pr.headSha },
    {
      baseBranch: "main",
      headBranch: "chore/paseo-sdk-0.9.2",
      baseSha: "41ff25de85931953ace4daa1a7923e20823514c5",
      startSha: "41ff25de85931953ace4daa1a7923e20823514c5",
      headSha: "a711a639b04f3bd2bfe514157e0c19880fe33028",
    },
  );
  assert.deepEqual({ additions: pr.additions, deletions: pr.deletions }, { additions: 63, deletions: 43 });

  assert.equal(pr.commits.length, 3);
  assert.equal(pr.commits[0]?.author, "sleeyax");
  assert.match(pr.commits[0]?.sha ?? "", /^[0-9a-f]{40}$/);

  assert.deepEqual(
    pr.linkedIssues.map(({ number, title, state }) => ({ number, title, state })),
    [{ number: 89, title: "Bump the Paseo SDK to 0.9.2 across the workspace", state: "CLOSED" }],
  );

  assert.deepEqual(
    pr.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    [
      { path: "apps/claude-tty-acp/src/claude-runtime.test.ts", status: "modified", additions: 29, deletions: 9 },
      { path: "plugins/catppuccin-theme/package.json", status: "modified", additions: 1, deletions: 1 },
      { path: "plugins/claude-tty/CLAUDE.md", status: "modified", additions: 1, deletions: 1 },
      { path: "plugins/claude-tty/package.json", status: "modified", additions: 2, deletions: 2 },
      { path: "plugins/discord-rich-presence/package.json", status: "modified", additions: 2, deletions: 2 },
      { path: "pnpm-lock.yaml", status: "modified", additions: 28, deletions: 28 },
    ],
  );
  assert.match(pr.files[1]?.patch ?? "", /^@@ -8,7 \+8,7 @@/);
});

test("keeps where a renamed file came from, and that a binary file has no patch", async () => {
  const files = [
    ...JSON.parse(fixture("files.json")),
    { filename: "docs/logo.png", previous_filename: "logo.png", status: "renamed", additions: 0, deletions: 0 },
  ];
  const { forge } = forgeReplaying([{ stdout: fixture("pull-request.json") }, { stdout: JSON.stringify(files) }]);

  const pr = await forge.fetchChangeRequest(PR_105);

  assert.deepEqual(pr.files.at(-1), {
    path: "docs/logo.png",
    previousPath: "logo.png",
    status: "renamed",
    additions: 0,
    deletions: 0,
    patch: null,
  });
});

test("a pull request gh cannot find fails in gh's own words", async () => {
  const { forge, run } = forgeReplaying([
    {
      exitCode: 1,
      stdout: fixture("pull-request-missing.json"),
      stderr: "gh: Could not resolve to a PullRequest with the number of 999999.\n",
    },
  ]);

  await assert.rejects(
    forge.fetchChangeRequest({ ...PR_105, number: 999999 }),
    new ForgeError("gh failed: Could not resolve to a PullRequest with the number of 999999."),
  );
  assert.equal(run.calls.length, 1, "the file list is not asked for");
});

test("a gh that cannot run points at the setting", async () => {
  const { forge } = forgeReplaying([{ exitCode: null, spawnError: "spawn /opt/gh/bin/gh ENOENT" }]);

  await assert.rejects(
    forge.fetchChangeRequest(PR_105),
    new ForgeError(
      'Could not run gh at "/opt/gh/bin/gh" (spawn /opt/gh/bin/gh ENOENT). Set the gh path in the Guided Review settings.',
    ),
  );
});

test("identifies the current user on the pull request's host", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("user.json") }]);

  assert.deepEqual(await forge.currentUser(PR_105), { login: "sleeyax", name: "Sleeyax" });
  assert.deepEqual(run.calls.map((call) => call.args), [["api", "--hostname", "github.com", "user"]]);
});

test("clones the pull request's repository with gh", async () => {
  const { forge, run } = forgeReplaying([{}]);

  await forge.cloneRepository(PR_105, "/data/clones/github.com/sleeyax/paseo-plugins");

  assert.deepEqual(run.calls.map((call) => call.args), [
    ["repo", "clone", "github.com/sleeyax/paseo-plugins", "/data/clones/github.com/sleeyax/paseo-plugins"],
  ]);
});

/*
 * Drafts. The GraphQL answers under `fixtures/github/` named `pending-review*`, `start-review` and
 * `drafts-*` are built by hand from GitHub's schema for #105, since recording them would write to a
 * real pull request; the mutation answers below are too.
 */

const PR_105_TARGET: DraftTarget = {
  ref: PR_105,
  baseSha: "41ff25de85931953ace4daa1a7923e20823514c5",
  startSha: "41ff25de85931953ace4daa1a7923e20823514c5",
  headSha: "a711a639b04f3bd2bfe514157e0c19880fe33028",
};

const PENDING_REVIEW_ID = "PRR_kwDOUFGNmM7x0Pnd";

/** Every call as it went out, as GraphQL: the query and variables sent on stdin. */
function graphqlCalls(run: FakeCommandRunner) {
  return run.calls.map((call) => {
    assert.deepEqual(call.args, ["api", "graphql", "--hostname", "github.com", "--input", "-"]);
    return JSON.parse(call.input ?? "null") as { query: string; variables: Record<string, unknown> };
  });
}

/** `addPullRequestReviewThread`'s answer for a new thread with one comment. */
function addedThread(thread: { path: string; line?: number; startLine?: number; diffSide?: string; startDiffSide?: string; subjectType?: string }) {
  const line = thread.line ?? null;
  const startLine = thread.startLine ?? null;
  return JSON.stringify({
    data: {
      addPullRequestReviewThread: {
        thread: {
          path: thread.path,
          line,
          originalLine: line,
          startLine,
          originalStartLine: startLine,
          diffSide: thread.diffSide ?? "RIGHT",
          startDiffSide: thread.startDiffSide ?? null,
          subjectType: thread.subjectType ?? "LINE",
          comments: { nodes: [{ id: "PRRC_kwDOUFGNmM6kZ9z9", body: "Why 0.9.2?" }] },
        },
      },
    },
  });
}

const ADDED: AnchorLine = { kind: "added", oldLine: null, newLine: 11, oldPos: 12, newPos: 11 };
const REMOVED: AnchorLine = { kind: "removed", oldLine: 11, newLine: null, oldPos: 11, newPos: 11 };
const CONTEXT: AnchorLine = { kind: "context", oldLine: 10, newLine: 10, oldPos: 10, newPos: 10 };
const PACKAGE_JSON = { path: "plugins/catppuccin-theme/package.json", previousPath: null };

test("lists the viewer's pending comments across every page of threads, and nobody else's", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("drafts-page-1.json") }, { stdout: fixture("drafts-page-2.json") }]);

  const drafts = await forge.listDrafts(PR_105);

  assert.deepEqual(graphqlCalls(run), [
    { query: DRAFTS_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105, after: null } },
    { query: DRAFTS_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105, after: "Y3Vyc29yOnYyOpHOAAAABg==" } },
  ]);
  assert.deepEqual(drafts, [
    {
      id: "PRRC_kwDOUFGNmM6kZ1a1",
      body: "Pin this to the host's version.",
      location: { kind: "line", path: "plugins/catppuccin-theme/package.json", line: { side: "new", line: 11 } },
    },
    {
      id: "PRRC_kwDOUFGNmM6kZ1a2",
      body: "Was 0.9.1 ever released?",
      location: { kind: "line", path: "plugins/claude-tty/package.json", line: { side: "old", line: 11 } },
    },
    {
      id: "PRRC_kwDOUFGNmM6kZ1a3",
      body: "Both bumps belong together.",
      location: {
        kind: "range",
        path: "plugins/claude-tty/package.json",
        start: { side: "old", line: 11 },
        end: { side: "new", line: 12 },
      },
    },
    { id: "PRRC_kwDOUFGNmM6kZ1a4", body: "Regenerated with pnpm 11?", location: { kind: "file", path: "pnpm-lock.yaml" } },
    // A pending reply to someone else's published thread sits where that thread does.
    {
      id: "PRRC_kwDOUFGNmM6kZ1a5",
      body: "Agreed, 0.9.2.",
      location: { kind: "line", path: "plugins/claude-tty/CLAUDE.md", line: { side: "new", line: 334 } },
    },
    // An outdated thread has no current line, so it keeps its original one.
    {
      id: "PRRC_kwDOUFGNmM6kZ1a6",
      body: "Name the key rather than the sequence.",
      location: { kind: "line", path: "apps/claude-tty-acp/src/claude-runtime.test.ts", line: { side: "new", line: 24 } },
    },
    {
      id: "PRRC_kwDOUFGNmM6kZ1a7",
      body: "A constant per key reads well.",
      location: {
        kind: "range",
        path: "apps/claude-tty-acp/src/claude-runtime.test.ts",
        start: { side: "new", line: 23 },
        end: { side: "new", line: 24 },
      },
    },
  ]);
});

test("a viewer with no pending review has no drafts, and no more pages are read", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("drafts-none.json") }]);

  assert.deepEqual(await forge.listDrafts(PR_105), []);
  assert.equal(run.calls.length, 1);
});

test("a draft goes on the pending review the viewer already has, even one started on github.com", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11 }) },
  ]);

  const draft = await forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "Why 0.9.2?" });

  assert.deepEqual(graphqlCalls(run), [
    { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
    {
      query: ADD_THREAD_MUTATION,
      variables: {
        input: {
          pullRequestReviewId: PENDING_REVIEW_ID,
          path: "plugins/catppuccin-theme/package.json",
          body: "Why 0.9.2?",
          subjectType: "LINE",
          line: 11,
          side: "RIGHT",
        },
      },
    },
  ]);
  assert.deepEqual(draft, {
    id: "PRRC_kwDOUFGNmM6kZ9z9",
    body: "Why 0.9.2?",
    location: { kind: "line", path: "plugins/catppuccin-theme/package.json", line: { side: "new", line: 11 } },
  });
});

test("without a pending review, one is started on the guide's head, pending, and the draft goes on it", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review-none.json") },
    { stdout: fixture("start-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11 }) },
  ]);

  await forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "Why 0.9.2?" });

  const calls = graphqlCalls(run);
  assert.deepEqual(calls.slice(0, 2), [
    { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
    {
      query: START_REVIEW_MUTATION,
      variables: { pullRequestId: "PR_kwDOUFGNmM8AAAABFhb6LA", commitOID: "a711a639b04f3bd2bfe514157e0c19880fe33028" },
    },
  ]);
  // No event: the review stays pending, and nothing is published until it is submitted.
  assert.doesNotMatch(START_REVIEW_MUTATION, /event/);
  assert.equal(calls[2]?.query, ADD_THREAD_MUTATION);
  assert.equal((calls[2]?.variables.input as { pullRequestReviewId: string }).pullRequestReviewId, "PRR_kwDOUFGNmM7x0Qaa");
});

test("drafts saved at once start one pending review between them", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review-none.json") },
    { stdout: fixture("start-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11 }) },
    { stdout: fixture("pending-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11, diffSide: "LEFT" }) },
  ]);

  await Promise.all([
    forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "One" }),
    forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: REMOVED }, body: "Two" }),
  ]);

  assert.deepEqual(
    graphqlCalls(run).map((call) => call.query),
    [PENDING_REVIEW_QUERY, START_REVIEW_MUTATION, ADD_THREAD_MUTATION, PENDING_REVIEW_QUERY, ADD_THREAD_MUTATION],
  );
});

test("each anchor becomes the thread fields GitHub anchors it by", async () => {
  const cases: { name: string; anchor: DraftAnchor; fields: Record<string, unknown>; answer: Parameters<typeof addedThread>[0] }[] = [
    {
      name: "an added line is on the RIGHT by its new number",
      anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED },
      fields: { subjectType: "LINE", line: 11, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, line: 11, diffSide: "RIGHT" },
    },
    {
      name: "a removed line is on the LEFT by its old number",
      anchor: { kind: "line", ...PACKAGE_JSON, line: REMOVED },
      fields: { subjectType: "LINE", line: 11, side: "LEFT" },
      answer: { path: PACKAGE_JSON.path, line: 11, diffSide: "LEFT" },
    },
    {
      name: "an unchanged line is on the RIGHT by its new number",
      anchor: { kind: "line", ...PACKAGE_JSON, line: { ...CONTEXT, oldLine: 9, oldPos: 9 } },
      fields: { subjectType: "LINE", line: 10, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, line: 10, diffSide: "RIGHT" },
    },
    {
      name: "a range sets its first line's number and side, then its last's",
      anchor: { kind: "range", ...PACKAGE_JSON, start: CONTEXT, end: ADDED },
      fields: { subjectType: "LINE", startLine: 10, startSide: "RIGHT", line: 11, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, startLine: 10, startDiffSide: "RIGHT", line: 11, diffSide: "RIGHT" },
    },
    {
      name: "a range from a removed line to an added one crosses sides",
      anchor: { kind: "range", ...PACKAGE_JSON, start: REMOVED, end: ADDED },
      fields: { subjectType: "LINE", startLine: 11, startSide: "LEFT", line: 11, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, startLine: 11, startDiffSide: "LEFT", line: 11, diffSide: "RIGHT" },
    },
    {
      name: "a file is subject type FILE, with no line",
      anchor: { kind: "file", path: "pnpm-lock.yaml", previousPath: null },
      fields: { subjectType: "FILE" },
      answer: { path: "pnpm-lock.yaml", subjectType: "FILE" },
    },
  ];

  for (const { name, anchor, fields, answer } of cases) {
    const { forge, run } = forgeReplaying([{ stdout: fixture("pending-review.json") }, { stdout: addedThread(answer) }]);

    const draft = await forge.createDraft(PR_105_TARGET, { anchor, body: "Why 0.9.2?" });

    assert.deepEqual(
      graphqlCalls(run)[1]?.variables,
      { input: { pullRequestReviewId: PENDING_REVIEW_ID, path: anchor.path, body: "Why 0.9.2?", ...fields } },
      name,
    );
    assert.equal(draft.location.kind, anchor.kind, name);
  }
});

test("a line GitHub cannot place fails in GitHub's words", async () => {
  const { forge } = forgeReplaying([
    { stdout: fixture("pending-review.json") },
    {
      exitCode: 1,
      stdout: JSON.stringify({ data: { addPullRequestReviewThread: { thread: null } }, errors: [{ message: "Line could not be resolved" }] }),
      stderr: "gh: Line could not be resolved\n",
    },
  ]);

  await assert.rejects(
    forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "Why?" }),
    new ForgeError("gh failed: Line could not be resolved"),
  );
});

test("edits a draft's text and deletes a draft by its comment ID", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: JSON.stringify({ data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: "PRRC_kwDOUFGNmM6kZ1a1" } } } }) },
    { stdout: JSON.stringify({ data: { deletePullRequestReviewComment: { pullRequestReviewComment: { id: "PRRC_kwDOUFGNmM6kZ1a2" } } } }) },
  ]);

  await forge.updateDraft(PR_105, "PRRC_kwDOUFGNmM6kZ1a1", "42");
  await forge.deleteDraft(PR_105, "PRRC_kwDOUFGNmM6kZ1a2");

  assert.deepEqual(graphqlCalls(run), [
    // The text goes as a JSON string, so a body of "42" stays text.
    { query: UPDATE_COMMENT_MUTATION, variables: { id: "PRRC_kwDOUFGNmM6kZ1a1", body: "42" } },
    { query: DELETE_COMMENT_MUTATION, variables: { id: "PRRC_kwDOUFGNmM6kZ1a2" } },
  ]);
});
