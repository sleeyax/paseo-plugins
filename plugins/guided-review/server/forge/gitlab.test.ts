import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { LineRef } from "../../shared/drafts.ts";
import { anchorAt } from "../anchors.ts";
import { fakeCommandRunner, type ScriptedResult } from "../fake-command-runner.ts";
import { createGitLabForge, parseMergeRequestUrl } from "./gitlab.ts";
import { ForgeError, type AnchorLine, type ChangeRequestRef, type DraftAnchor, type DraftTarget } from "./port.ts";

/**
 * Recorded from `glab` 1.119 against gitlab.com's gitlab-org/cli!3931, a merged MR from a fork, and
 * gitlab-org/cli's project (ID 34675721). The user is whichever account glab was logged in as,
 * trimmed to its public fields.
 */
function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", "gitlab", name), "utf8");
}

const GLAB = "/usr/bin/glab";

function forgeReplaying(script: readonly ScriptedResult[]) {
  const run = fakeCommandRunner(script);
  return { run, forge: createGitLabForge({ run, glab: async () => GLAB }) };
}

const MR_3931: ChangeRequestRef = {
  forge: "gitlab",
  host: "gitlab.com",
  project: "gitlab-org/cli",
  number: 3931,
  url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
};

const LOGGED_IN: ScriptedResult = { stderr: "gitlab.com\n  ✓ Logged in to gitlab.com as reviewer\n" };
const NOT_LOGGED_IN: ScriptedResult = { exitCode: 1, stderr: fixture("auth-status-unknown-host.stderr") };

/** The whole read of !3931, in the order the adapter asks for it. */
const READ_MR: readonly ScriptedResult[] = [
  LOGGED_IN,
  { stdout: fixture("project.json") },
  { stdout: fixture("merge-request.json") },
  { stdout: fixture("diffs.ndjson") },
  { stdout: fixture("commits.json") },
  { stdout: fixture("closes-issues.json") },
];

test("takes a merge request URL however it was copied", async () => {
  for (const url of [
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
    "  https://gitlab.com/gitlab-org/cli/-/merge_requests/3931/diffs  ",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931#note_123",
    "https://GitLab.com/gitlab-org/cli/-/merge_requests/3931?tab=commits",
    "gitlab.com/gitlab-org/cli/-/merge_requests/3931",
  ]) {
    assert.deepEqual(parseMergeRequestUrl(url), MR_3931, url);
  }
});

test("reads a subgroup path and a self-hosted host, keeping its port only in the URL", () => {
  assert.deepEqual(parseMergeRequestUrl("https://git.example.com:8443/acme/platform/uploader/-/merge_requests/7/commits"), {
    forge: "gitlab",
    host: "git.example.com",
    project: "acme/platform/uploader",
    number: 7,
    url: "https://git.example.com:8443/acme/platform/uploader/-/merge_requests/7",
  });
  assert.equal(parseMergeRequestUrl("http://gitlab.internal/team/app/-/merge_requests/12")?.url, "http://gitlab.internal/team/app/-/merge_requests/12");
});

test("turns down anything that is not a merge request URL, without running glab", async () => {
  const { forge, run } = forgeReplaying([]);
  for (const url of [
    "",
    "not a url",
    "https://gitlab.com/gitlab-org/cli",
    "https://gitlab.com/gitlab-org/cli/-/issues/8557",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/0",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/abc",
    "https://gitlab.com/cli/-/merge_requests/1",
    "https://gitlab.com/gitlab-org/../cli/-/merge_requests/1",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/-/merge_requests/1",
    "ftp://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
  ]) {
    assert.equal(await forge.matchUrl(url), null, url);
  }
  assert.deepEqual(run.calls, []);
});

test("takes a merge request URL only on a host glab is logged in to, and asks each host once", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, NOT_LOGGED_IN]);

  assert.deepEqual(await forge.matchUrl(MR_3931.url), MR_3931);
  assert.deepEqual(await forge.matchUrl(`${MR_3931.url}/diffs`), MR_3931);
  await assert.rejects(
    forge.matchUrl("https://git.example.com/acme/app/-/merge_requests/7"),
    new ForgeError("glab is not logged in to git.example.com. Run `glab auth login --hostname git.example.com` on the daemon's host."),
  );

  assert.deepEqual(
    run.calls.map((call) => [call.file, ...call.args]),
    [
      [GLAB, "auth", "status", "--hostname", "gitlab.com"],
      [GLAB, "auth", "status", "--hostname", "git.example.com"],
    ],
  );
});

test("reads a merge request's metadata, diff refs, files, commits and linked issues through glab api", async () => {
  const { forge, run } = forgeReplaying(READ_MR);

  const mr = await forge.fetchChangeRequest(MR_3931);

  assert.deepEqual(
    run.calls.map((call) => ({ file: call.file, args: call.args, input: call.input })),
    [
      { file: GLAB, args: ["auth", "status", "--hostname", "gitlab.com"], input: undefined },
      { file: GLAB, args: ["api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"], input: undefined },
      { file: GLAB, args: ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931"], input: undefined },
      {
        file: GLAB,
        args: [
          "api",
          "--hostname",
          "gitlab.com",
          "projects/34675721/merge_requests/3931/diffs?per_page=100",
          "--paginate",
          "--output",
          "ndjson",
        ],
        input: undefined,
      },
      { file: GLAB, args: ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/commits?per_page=100"], input: undefined },
      {
        file: GLAB,
        args: ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/closes_issues?per_page=25"],
        input: undefined,
      },
    ],
  );

  assert.equal(mr.ref, MR_3931);
  assert.equal(mr.title, "feat: mr note create support for internal notes/threads");
  assert.match(mr.description, /^## Description\n\nAdds support for internal notes/);
  assert.deepEqual(mr.author, { login: "gkepas", name: "Giannis Kepas" });
  assert.equal(mr.state, "merged");
  assert.equal(mr.isDraft, false);
  assert.deepEqual(
    {
      baseBranch: mr.baseBranch,
      headBranch: mr.headBranch,
      baseSha: mr.baseSha,
      startSha: mr.startSha,
      headSha: mr.headSha,
    },
    {
      baseBranch: "main",
      headBranch: "8557-mr-internal-notes",
      baseSha: "a34c75cf567863b8d4acbcf739625ca291a3c99d",
      startSha: "c1c0a9f1f0fd33d96b9aa47c690734e8628c6847",
      headSha: "8e1ef79fe55aae06f0c7246e550f8c30075b7564",
    },
  );
  // GitLab's own diffStatsSummary for !3931 says 284 and 10.
  assert.deepEqual({ additions: mr.additions, deletions: mr.deletions }, { additions: 284, deletions: 10 });

  assert.deepEqual(
    mr.commits.map(({ sha, headline, body, author }) => ({ sha: sha.slice(0, 8), headline, body, author })),
    [
      { sha: "942ec009", headline: "feat: mr note create supports internal notes", body: "", author: "Giannis Kepas" },
      { sha: "b1faf4bb", headline: "chore: apply doc suggestions", body: "", author: "Giannis Kepas" },
      { sha: "16426966", headline: "chore: use MarkFlagsMutuallyExclusive for flag checking", body: "", author: "Giannis Kepas" },
      { sha: "8e1ef79f", headline: "chore: Apply 1 suggestion(s) to 1 file(s)", body: "", author: "Ahmed Hemdan" },
    ],
  );
  assert.equal(mr.commits[0]?.authoredAt, "2026-09-17T13:23:29.000+03:00");

  assert.deepEqual(
    mr.linkedIssues.map(({ number, url, title, state }) => ({ number, url, title, state })),
    [
      {
        number: 8557,
        url: "https://gitlab.com/gitlab-org/cli/-/work_items/8557",
        title: "glab mr note create cannot post an internal note",
        state: "closed",
      },
    ],
  );
  assert.match(mr.linkedIssues[0]?.body ?? "", /^The GitLab API supports internal notes/);

  assert.deepEqual(
    mr.files.map(({ path, previousPath, status, additions, deletions }) => ({ path, previousPath, status, additions, deletions })),
    [
      { path: "docs/source/mr/note/create.md", previousPath: null, status: "modified", additions: 13, deletions: 0 },
      { path: "internal/commands/mr/mrutils/discussions.go", previousPath: null, status: "modified", additions: 30, deletions: 6 },
      { path: "internal/commands/mr/note/mr_note_create.go", previousPath: null, status: "modified", additions: 42, deletions: 4 },
      { path: "internal/commands/mr/note/mr_note_create_test.go", previousPath: null, status: "modified", additions: 199, deletions: 0 },
    ],
  );
  const patch = mr.files[0]?.patch ?? "";
  assert.match(patch, /^@@ -22,6 \+22,8 @@/);
  assert.equal(patch.endsWith("\n"), false, "the patch ends where GitHub's does");
});

test("keeps where a renamed file came from, and that a withheld or binary diff is no patch", async () => {
  const extra = [
    { old_path: "a.ts", new_path: "b.ts", new_file: false, renamed_file: true, deleted_file: false, diff: "" },
    { old_path: "new.ts", new_path: "new.ts", new_file: true, renamed_file: false, deleted_file: false, diff: "@@ -0,0 +1,2 @@\n+a\n+b\n" },
    { old_path: "gone.ts", new_path: "gone.ts", new_file: false, renamed_file: false, deleted_file: true, diff: "@@ -1 +0,0 @@\n-a\n" },
    { old_path: "big.json", new_path: "big.json", new_file: false, renamed_file: false, deleted_file: false, diff: "", too_large: true },
    { old_path: "logo.png", new_path: "logo.png", new_file: false, renamed_file: false, deleted_file: false, diff: "Binary files differ\n" },
  ];
  const script = [...READ_MR];
  script[3] = { stdout: fixture("diffs.ndjson") + extra.map((entry) => JSON.stringify(entry)).join("\n") };
  const { forge } = forgeReplaying(script);

  const mr = await forge.fetchChangeRequest(MR_3931);

  assert.deepEqual(mr.files.slice(4), [
    { path: "b.ts", previousPath: "a.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
    { path: "new.ts", previousPath: null, status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
    { path: "gone.ts", previousPath: null, status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-a" },
    { path: "big.json", previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null },
    { path: "logo.png", previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null },
  ]);
  assert.deepEqual({ additions: mr.additions, deletions: mr.deletions }, { additions: 286, deletions: 11 });
});

test("looks a project's numeric ID up once and addresses it by that ID after", async () => {
  const { forge, run } = forgeReplaying([
    ...READ_MR,
    { stdout: fixture("merge-request.json") },
    { stdout: fixture("diffs.ndjson") },
    { stdout: fixture("commits.json") },
    { stdout: fixture("closes-issues.json") },
  ]);

  await forge.fetchChangeRequest(MR_3931);
  await forge.fetchChangeRequest({ ...MR_3931, project: "GitLab-org/CLI" });

  const paths = run.calls.map((call) => call.args.find((arg) => arg.startsWith("projects/")) ?? call.args[0]);
  assert.equal(paths.filter((entry) => entry === "projects/gitlab-org%2Fcli").length, 1);
  assert.equal(paths.filter((entry) => entry === "auth").length, 1);
  assert.equal(paths.at(-4), "projects/34675721/merge_requests/3931");
});

test("encodes every slash of a subgroup path in the project lookup", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: '{"id":99}' }, { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" }]);

  await assert.rejects(forge.fetchChangeRequest({ ...MR_3931, project: "acme/platform/uploader", number: 7 }));
  assert.deepEqual(run.calls.slice(1).map((call) => call.args.at(-1)), [
    "projects/acme%2Fplatform%2Fuploader",
    "projects/99/merge_requests/7",
  ]);
});

test("a merge request glab cannot find fails in glab's own words", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { exitCode: 1, stdout: fixture("merge-request-missing.json"), stderr: fixture("merge-request-missing.stderr") },
  ]);

  await assert.rejects(forge.fetchChangeRequest({ ...MR_3931, number: 999999 }), new ForgeError("glab failed: 404 Not found (HTTP 404)"));
  assert.equal(run.calls.length, 3, "the diffs are not asked for");
});

test("a merge request GitLab has no diff for yet says so", async () => {
  const noDiff = JSON.stringify({ ...JSON.parse(fixture("merge-request.json")), diff_refs: null });
  const { forge } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: noDiff }]);

  await assert.rejects(
    forge.fetchChangeRequest(MR_3931),
    new ForgeError(`GitLab has not worked out the diff of ${MR_3931.url} yet. Try again in a moment.`),
  );
});

test("never runs glab against a host it is not logged in to", async () => {
  const { forge, run } = forgeReplaying([NOT_LOGGED_IN]);

  await assert.rejects(forge.currentUser({ ...MR_3931, host: "git.example.com" }), ForgeError);
  assert.equal(run.calls.length, 1, "only the login check ran");
});

test("a glab that cannot run points at the setting", async () => {
  const { forge } = forgeReplaying([{ exitCode: null, spawnError: "spawn /usr/bin/glab ENOENT" }]);

  await assert.rejects(
    forge.matchUrl(MR_3931.url),
    new ForgeError('Could not run glab at "/usr/bin/glab" (spawn /usr/bin/glab ENOENT). Set the glab path in the Guided Review settings.'),
  );
});

test("glab runs without an agent's identity and without prompts", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("user.json") }]);

  await forge.currentUser(MR_3931);

  for (const call of run.calls) {
    assert.deepEqual(call.unsetEnv, ["PASEO_AGENT_ID", "GITLAB_BOT_IDENTITY"]);
    assert.equal(call.env?.NO_PROMPT, "1");
    assert.equal(call.env?.GLAB_CHECK_UPDATE, "0");
  }
});

test("reads where a merge request's diff head is now and its state, by the project's numeric ID", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: fixture("merge-request.json") }]);

  assert.deepEqual(await forge.fetchHead(MR_3931), { headSha: "8e1ef79fe55aae06f0c7246e550f8c30075b7564", state: "merged" });
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931"]);
});

test("a merge request whose diff GitLab has not worked out yet has its source branch's head", async () => {
  const mr = { ...JSON.parse(fixture("merge-request.json")), state: "opened", diff_refs: null, sha: "d".repeat(40) };
  const { forge } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: JSON.stringify(mr) }]);

  assert.deepEqual(await forge.fetchHead(MR_3931), { headSha: "d".repeat(40), state: "open" });
});

test("identifies the current user on the merge request's host", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("user.json") }]);

  assert.deepEqual(await forge.currentUser(MR_3931), { login: "quack-overflow", name: "QuackOverflow" });
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "user"]);
});

test("clones the merge request's repository with glab", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, {}]);

  await forge.cloneRepository(MR_3931, "/data/clones/gitlab.com/gitlab-org/cli");

  assert.deepEqual(run.calls.at(-1)?.args, ["repo", "clone", "https://gitlab.com/gitlab-org/cli", "/data/clones/gitlab.com/gitlab-org/cli"]);
});

test("a failure glab prints as a box is told in its words, not its title", async () => {
  const { forge } = forgeReplaying([LOGGED_IN, NOT_LOGGED_IN]);

  await assert.rejects(
    forge.cloneRepository(MR_3931, "/data/clones/gitlab.com/gitlab-org/cli"),
    new ForgeError(
      "glab failed: gitlab.example.invalid has not been authenticated with glab; run `glab auth login --hostname gitlab.example.invalid` to authenticate.",
    ),
  );
});

test("finds the open merge request whose source branch is a workspace's branch, by the project's numeric ID", async () => {
  // Recorded for gitlab-org/cli's 7699-follow-up-validate-spec-for-components, which has !3967 open.
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: fixture("merge-requests-for-branch.json") }]);

  assert.deepEqual(await forge.findByBranch({ host: "gitlab.com", project: "gitlab-org/cli" }, "7699-follow-up-validate-spec-for-components"), [
    {
      ref: {
        forge: "gitlab",
        host: "gitlab.com",
        project: "gitlab-org/cli",
        number: 3967,
        url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/3967",
      },
      title: "chore: spec validation added",
      author: "donaldcook",
      headSha: JSON.parse(fixture("merge-requests-for-branch.json"))[0].sha,
    },
  ]);
  assert.deepEqual(run.calls.at(-1)?.args, [
    "api",
    "--hostname",
    "gitlab.com",
    "projects/34675721/merge_requests?source_branch=7699-follow-up-validate-spec-for-components&state=opened&per_page=20",
  ]);
});

test("a branch name is encoded in the merge request query, and github.com is not GitLab's", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: "[]" }]);

  assert.deepEqual(await forge.findByBranch({ host: "gitlab.com", project: "gitlab-org/cli" }, "feat/a&b"), []);
  assert.equal(await forge.findByBranch({ host: "github.com", project: "gitlab-org/cli" }, "main"), null);
  assert.equal(run.calls.at(-1)?.args.at(-1), "projects/34675721/merge_requests?source_branch=feat%2Fa%26b&state=opened&per_page=20");
  assert.equal(run.calls.length, 3);
});

test("a repository on a host glab is not logged in to is turned down before anything is asked of it", async () => {
  const { forge, run } = forgeReplaying([NOT_LOGGED_IN]);

  await assert.rejects(forge.findByBranch({ host: "gitlab.example.com", project: "acme/app" }, "main"), ForgeError);
  assert.equal(run.calls.length, 1, "only the login check ran");
});

// Drafts. Nothing here is recorded, since a draft note is a write to a real MR: `draft-notes.ndjson`,
// `discussions.ndjson` and the answers below are built by hand from GitLab's draft notes and
// discussions API docs, on !3931's diff refs and files.

const MR_3931_TARGET: DraftTarget = {
  ref: MR_3931,
  baseSha: "a34c75cf567863b8d4acbcf739625ca291a3c99d",
  startSha: "c1c0a9f1f0fd33d96b9aa47c690734e8628c6847",
  headSha: "8e1ef79fe55aae06f0c7246e550f8c30075b7564",
};
const DIFF_REFS = { base_sha: MR_3931_TARGET.baseSha, start_sha: MR_3931_TARGET.startSha, head_sha: MR_3931_TARGET.headSha };

/** Lines of the first hunk of discussions.go in !3931, `@@ -143,28 +143,52 @@`, as `parsePatch` reads them. */
const GO_PATH = "internal/commands/mr/mrutils/discussions.go";
const GO = { path: GO_PATH, previousPath: null };
const GO_PATHS = { old_path: GO_PATH, new_path: GO_PATH };
/** `echo -n internal/commands/mr/mrutils/discussions.go | sha1sum` */
const GO_SHA1 = "58b4176ff8bffa189fe52755b949fc37c46ca010";
const CONTEXT_145: AnchorLine = { kind: "context", oldLine: 145, newLine: 145, oldPos: 145, newPos: 145 };
const ADDED_146: AnchorLine = { kind: "added", oldLine: null, newLine: 146, oldPos: 146, newPos: 146 };
const ADDED_147: AnchorLine = { kind: "added", oldLine: null, newLine: 147, oldPos: 146, newPos: 147 };
const REMOVED_148: AnchorLine = { kind: "removed", oldLine: 148, newLine: null, oldPos: 148, newPos: 159 };
const MD_PATH = "docs/source/mr/note/create.md";

const DRAFT_NOTES = "projects/34675721/merge_requests/3931/draft_notes";
const JSON_BODY = ["--header", "Content-Type: application/json", "--input", "-"];

/** The first `count` draft notes of the hand-built listing. */
function draftNotesFixture(count?: number): string {
  return fixture("draft-notes.ndjson").split("\n").filter((line) => line !== "").slice(0, count).join("\n");
}

/** A draft note as GitLab answers with one: its entity's every field, the position's unset ones null. */
function draftNote(id: number, note: string, position: Record<string, unknown> | null): ScriptedResult {
  const kept =
    position === null
      ? null
      : { old_path: null, new_path: null, old_line: null, new_line: null, line_range: null, ...position };
  return {
    stdout: JSON.stringify({
      id,
      author_id: 21230898,
      merge_request_id: 533339747,
      resolve_discussion: false,
      discussion_id: null,
      note,
      commit_id: null,
      line_code: null,
      position: kept,
    }),
  };
}

test("the anchor lines above are the diff's own, with GitLab's running counters", async () => {
  const { forge } = forgeReplaying(READ_MR);
  const files = (await forge.fetchChangeRequest(MR_3931)).files;
  const at = (line: LineRef) => {
    const anchor = anchorAt(files, { kind: "line", path: GO_PATH, line });
    return anchor.kind === "line" ? anchor.line : null;
  };

  assert.deepEqual(at({ side: "new", line: 145 }), CONTEXT_145);
  assert.deepEqual(at({ side: "new", line: 146 }), ADDED_146);
  assert.deepEqual(at({ side: "new", line: 147 }), ADDED_147);
  assert.deepEqual(at({ side: "old", line: 148 }), REMOVED_148);
});

test("lists the viewer's draft notes by the project's numeric ID, a reply where its thread is, and not the MR-level ones", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: fixture("draft-notes.ndjson") },
    { stdout: fixture("discussions.ndjson") },
  ]);

  const drafts = await forge.listDrafts(MR_3931);

  assert.deepEqual(
    run.calls.slice(1).map((call) => call.args),
    [
      ["api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"],
      ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}?per_page=100`, "--paginate", "--output", "ndjson"],
      ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/discussions?per_page=100", "--paginate", "--output", "ndjson"],
    ],
  );
  assert.deepEqual(drafts, [
    // Started on the web, which sends a one-line `line_range` even for a single line.
    { id: "101", body: "Why a second lookup here?", location: { kind: "line", path: GO_PATH, line: { side: "new", line: 146 } } },
    {
      id: "102",
      body: "This block reads well.",
      location: { kind: "range", path: GO_PATH, start: { side: "new", line: 145 }, end: { side: "new", line: 147 } },
    },
    { id: "103", body: "Was this message used anywhere else?", location: { kind: "line", path: GO_PATH, line: { side: "old", line: 148 } } },
    { id: "104", body: "The docs could mention the flag earlier.", location: { kind: "file", path: MD_PATH } },
    { id: "106", body: "Agreed, and the same goes for replies.", location: { kind: "line", path: MD_PATH, line: { side: "new", line: 25 } } },
  ]);
});

test("without a reply among the drafts the MR's discussions are not read", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: draftNotesFixture(5) }]);

  assert.deepEqual((await forge.listDrafts(MR_3931)).map((draft) => draft.id), ["101", "102", "103", "104"]);
  assert.equal(run.calls.length, 3);
});

test("each anchor becomes the draft note position GitLab anchors it by, sent as JSON to the numeric project ID", async () => {
  const range = (start: AnchorLine, end: AnchorLine): DraftAnchor => ({ kind: "range", ...GO, start, end });
  const cases: { anchor: DraftAnchor; position: Record<string, unknown>; location: unknown }[] = [
    {
      anchor: { kind: "line", ...GO, line: ADDED_146 },
      position: { position_type: "text", ...DIFF_REFS, ...GO_PATHS, new_line: 146 },
      location: { kind: "line", path: GO_PATH, line: { side: "new", line: 146 } },
    },
    {
      anchor: { kind: "line", ...GO, line: REMOVED_148 },
      position: { position_type: "text", ...DIFF_REFS, ...GO_PATHS, old_line: 148 },
      location: { kind: "line", path: GO_PATH, line: { side: "old", line: 148 } },
    },
    {
      anchor: { kind: "line", ...GO, line: CONTEXT_145 },
      position: { position_type: "text", ...DIFF_REFS, ...GO_PATHS, old_line: 145, new_line: 145 },
      location: { kind: "line", path: GO_PATH, line: { side: "new", line: 145 } },
    },
    {
      anchor: range(CONTEXT_145, ADDED_147),
      position: {
        position_type: "text",
        ...DIFF_REFS,
        ...GO_PATHS,
        new_line: 147,
        line_range: {
          start: { line_code: `${GO_SHA1}_145_145`, type: null, old_line: 145, new_line: 145 },
          end: { line_code: `${GO_SHA1}_146_147`, type: "new", old_line: null, new_line: 147 },
        },
      },
      location: { kind: "range", path: GO_PATH, start: { side: "new", line: 145 }, end: { side: "new", line: 147 } },
    },
    {
      anchor: range(ADDED_146, REMOVED_148),
      position: {
        position_type: "text",
        ...DIFF_REFS,
        ...GO_PATHS,
        old_line: 148,
        line_range: {
          start: { line_code: `${GO_SHA1}_146_146`, type: "new", old_line: null, new_line: 146 },
          end: { line_code: `${GO_SHA1}_148_159`, type: "old", old_line: 148, new_line: null },
        },
      },
      location: { kind: "range", path: GO_PATH, start: { side: "new", line: 146 }, end: { side: "old", line: 148 } },
    },
    {
      anchor: { kind: "file", path: "cmd/new.go", previousPath: "cmd/old.go" },
      position: { position_type: "file", ...DIFF_REFS, old_path: "cmd/old.go", new_path: "cmd/new.go" },
      location: { kind: "file", path: "cmd/new.go" },
    },
  ];

  for (const { anchor, position, location } of cases) {
    const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, draftNote(201, "Why?", position)]);

    const draft = await forge.createDraft(MR_3931_TARGET, { anchor, body: "Why?" });

    const call = run.calls.at(-1)!;
    assert.deepEqual(call.args, ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, DRAFT_NOTES], anchor.kind);
    assert.deepEqual(JSON.parse(call.input!), { note: "Why?", position }, JSON.stringify(anchor));
    assert.deepEqual(draft, { id: "201", body: "Why?", location });
    assert.equal(run.calls.length, 3, "nothing is taken back");
  }
});

test("a draft GitLab kept somewhere other than where it was put is deleted again, and the reviewer told", async () => {
  const sent = { position_type: "text", ...DIFF_REFS, ...GO_PATHS, old_line: 145, new_line: 145 };
  for (const kept of [
    // A body read as a form loses its position, which leaves an MR-level draft.
    null,
    { position_type: "text", ...DIFF_REFS, ...GO_PATHS, new_line: 145 },
    { ...sent, head_sha: "73472a4e0000000000000000000000000000000" },
  ]) {
    const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, draftNote(202, "Why?", kept), {}]);

    await assert.rejects(
      forge.createDraft(MR_3931_TARGET, { anchor: { kind: "line", ...GO, line: CONTEXT_145 }, body: "Why?" }),
      new ForgeError("GitLab did not keep the comment where it was put, so the draft was deleted again. This GitLab may not take comments of this kind."),
    );
    assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "--method", "DELETE", `${DRAFT_NOTES}/202`]);
  }

  // A range GitLab kept as its last line alone is not the range either.
  const rangeSent = positionOfRange();
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    draftNote(203, "Why?", { ...rangeSent, line_range: null }),
    {},
  ]);
  await assert.rejects(forge.createDraft(MR_3931_TARGET, { anchor: { kind: "range", ...GO, start: CONTEXT_145, end: ADDED_147 }, body: "Why?" }), ForgeError);
  assert.deepEqual(run.calls.at(-1)?.args.at(-1), `${DRAFT_NOTES}/203`);
});

function positionOfRange(): Record<string, unknown> {
  return {
    position_type: "text",
    ...DIFF_REFS,
    ...GO_PATHS,
    new_line: 147,
    line_range: {
      start: { line_code: `${GO_SHA1}_145_145`, type: null, old_line: 145, new_line: 145 },
      end: { line_code: `${GO_SHA1}_146_147`, type: "new", old_line: null, new_line: 147 },
    },
  };
}

test("a misplaced draft that cannot be deleted either is left for the reviewer to delete, in so many words", async () => {
  const { forge } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    draftNote(204, "Why?", null),
    { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" },
  ]);

  await assert.rejects(
    forge.createDraft(MR_3931_TARGET, { anchor: { kind: "file", ...GO }, body: "Why?" }),
    new ForgeError(
      "GitLab did not keep the comment where it was put, and deleting the misplaced draft failed too (glab failed: 404 Not found (HTTP 404)). Delete it on the merge request's page before submitting.",
    ),
  );
});

test("an edit sends the draft's own position back with the new text, since one sent without it is wiped", async () => {
  const [, rangeDraft, , , mrLevelDraft] = draftNotesFixture().split("\n");
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: rangeDraft },
    { stdout: rangeDraft },
    { stdout: mrLevelDraft },
    { stdout: mrLevelDraft },
  ]);

  await forge.updateDraft(MR_3931, "102", "This block reads very well.");
  await forge.updateDraft(MR_3931, "105", "Overall this looks great.");

  assert.deepEqual(
    run.calls.slice(2).map((call) => call.args),
    [
      ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}/102`],
      ["api", "--hostname", "gitlab.com", "--method", "PUT", ...JSON_BODY, `${DRAFT_NOTES}/102`],
      ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}/105`],
      ["api", "--hostname", "gitlab.com", "--method", "PUT", ...JSON_BODY, `${DRAFT_NOTES}/105`],
    ],
  );
  assert.deepEqual(JSON.parse(run.calls[3]!.input!), { note: "This block reads very well.", position: JSON.parse(rangeDraft!).position });
  // An MR-level draft's all-null position is not one GitLab would take back.
  assert.deepEqual(JSON.parse(run.calls[5]!.input!), { note: "Overall this looks great." });
});

test("deletes a draft note by its ID, and takes nothing but a GitLab ID", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, {}]);

  await forge.deleteDraft(MR_3931, "103");
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "--method", "DELETE", `${DRAFT_NOTES}/103`]);

  for (const id of ["PRRC_kwDOUFGNmM6", "103/publish", "../1", "0", ""]) {
    await assert.rejects(forge.deleteDraft(MR_3931, id), ForgeError, id);
    await assert.rejects(forge.updateDraft(MR_3931, id, "text"), ForgeError, id);
  }
  assert.equal(run.calls.length, 3, "nothing more ran");
});
