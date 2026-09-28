import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeCommandRunner, type ScriptedResult } from "../fake-command-runner.ts";
import { createGitHubForge, PULL_REQUEST_HEAD_QUERY, PULL_REQUEST_QUERY } from "./github.ts";
import { ForgeError, type ChangeRequestRef } from "./port.ts";

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

test("reads only where a pull request's head is now and its state, for noticing a push", async () => {
  // The recorded pull request's own head and state, as the smaller query returns them.
  const { headRefOid, state } = JSON.parse(fixture("pull-request.json")).data.repository.pullRequest;
  const { forge, run } = forgeReplaying([{ stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid, state } } } }) }]);

  assert.deepEqual(await forge.fetchHead(PR_105), { headSha: "a711a639b04f3bd2bfe514157e0c19880fe33028", state: "merged" });
  assert.deepEqual(
    run.calls.map((call) => ({ args: call.args, input: call.input && JSON.parse(call.input) })),
    [
      {
        args: ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        input: { query: PULL_REQUEST_HEAD_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
      },
    ],
  );
});

test("the head of a pull request GitHub does not have fails with a sentence", async () => {
  const { forge } = forgeReplaying([{ stdout: fixture("pull-request-missing.json") }]);

  await assert.rejects(forge.fetchHead(PR_105), new ForgeError("sleeyax/paseo-plugins has no pull request #105."));
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

test("finds the open pull request whose source branch is a workspace's branch", async () => {
  // Recorded for sleeyax/paseo-plugins' feat/guided-review, which has #107 open.
  const { forge, run } = forgeReplaying([{ stdout: fixture("pull-requests-for-branch.json") }]);

  assert.deepEqual(await forge.findByBranch({ host: "github.com", project: "sleeyax/paseo-plugins" }, "feat/guided-review"), [
    {
      ref: {
        forge: "github",
        host: "github.com",
        project: "sleeyax/paseo-plugins",
        number: 107,
        url: "https://github.com/sleeyax/paseo-plugins/pull/107",
      },
      title: "feat(guided-review): a trunk-first guide to a PR/MR, with a draft review built alongside it",
      author: "sleeyax",
      headSha: "5b416c8bfea2017be77fe2081fcbe223e1b82ecb",
    },
  ]);
  assert.deepEqual(run.calls.map((call) => call.args), [
    [
      "pr",
      "list",
      "--repo",
      "github.com/sleeyax/paseo-plugins",
      "--head",
      "feat/guided-review",
      "--state",
      "open",
      "--json",
      "number,url,title,author,headRefOid",
      "--limit",
      "20",
    ],
  ]);
});

test("a branch with no open pull request finds none, and a repository elsewhere is not GitHub's", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("pull-requests-for-branch-none.json") }]);

  assert.deepEqual(await forge.findByBranch({ host: "github.com", project: "sleeyax/paseo-plugins" }, "no-such-branch"), []);
  assert.equal(await forge.findByBranch({ host: "gitlab.com", project: "sleeyax/paseo-plugins" }, "main"), null);
  assert.equal(run.calls.length, 1, "gh is not asked about another host");
});
