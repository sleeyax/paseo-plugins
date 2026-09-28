import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeCommandRunner, type ScriptedResult } from "../fake-command-runner.ts";
import { createGitLabForge, parseMergeRequestUrl } from "./gitlab.ts";
import { ForgeError, type ChangeRequestRef } from "./port.ts";

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
