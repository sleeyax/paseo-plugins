import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCommand, type CommandRunner } from "../command-runner.ts";
import { fastForward, fetchMissing, readCheckout } from "./checkout.ts";

/**
 * Real throwaway repositories: a bare `origin` with a change request's head under `refs/pull/7/head`,
 * and a clone of it on `retry-uploads` standing in for the reviewer's workspace. The host's git
 * config stays out, so signing, hooks and a global default branch cannot change what is tested.
 */
const ISOLATED = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Rita Reviewer",
  GIT_AUTHOR_EMAIL: "rita@example.com",
  GIT_COMMITTER_NAME: "Rita Reviewer",
  GIT_COMMITTER_EMAIL: "rita@example.com",
};

const run: CommandRunner = (request) => runCommand({ ...request, env: { ...request.env, ...ISOLATED } });

const BRANCH = "retry-uploads";
const FETCH_REF = "refs/pull/7/head";

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, ...ISOLATED };
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function commit(cwd: string, file: string, text: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "--no-gpg-sign", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

type Repos = {
  /** The reviewer's checkout, on `retry-uploads` at `pushed`. */
  workspace: string;
  /** The branch's tip as the author pushed it, which the workspace has. */
  pushed: string;
  /** Publishes `sha` as the change request's head on `origin`. */
  publishHead(sha: string): void;
  /** The author's clone, where later commits of the change request are made. */
  author: string;
};

async function withRepos(t: TestContext): Promise<Repos> {
  const root = await mkdtemp(path.join(os.tmpdir(), "guided-review-checkout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const workspace = path.join(root, "workspace");

  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, author);
  await commit(author, "upload.ts", "export const retries = 0;\n", "Upload once");
  git(author, "push", "--quiet", "origin", "main");
  git(author, "switch", "--quiet", "-c", BRANCH);
  const pushed = await commit(author, "upload.ts", "export const retries = 3;\n", "Retry uploads");
  git(author, "push", "--quiet", "origin", BRANCH);

  git(root, "clone", "--quiet", "--branch", BRANCH, origin, workspace);
  const publishHead = (sha: string) => git(author, "push", "--quiet", "--force", "origin", `${sha}:${FETCH_REF}`);
  publishHead(pushed);
  return { workspace, pushed, publishHead, author };
}

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");

test("reads the branch a checkout is on and where its origin points", async (t) => {
  const { workspace } = await withRepos(t);

  const state = await readCheckout(run, workspace);

  assert.equal(state.branch, BRANCH);
  assert.equal(state.origin, path.join(path.dirname(workspace), "origin.git"));
});

test("a detached checkout is on no branch, and one without an origin has none", async (t) => {
  const { workspace } = await withRepos(t);
  git(workspace, "switch", "--quiet", "--detach");
  git(workspace, "remote", "remove", "origin");

  assert.deepEqual(await readCheckout(run, workspace), { branch: null, origin: null });
});

test("a branch already at the head is left as it is and reads as current", async (t) => {
  const { workspace, pushed } = await withRepos(t);

  const result = await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: pushed });

  assert.deepEqual(result, { status: "current" });
  assert.equal(head(workspace), pushed);
});

test("a clean branch the head is ahead of is fast-forwarded to it, working tree and all", async (t) => {
  const { workspace, pushed, author, publishHead } = await withRepos(t);
  const later = await commit(author, "retry.ts", "export const backoff = 2;\n", "Back off between retries");
  publishHead(later);

  const result = await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: later });

  assert.deepEqual(result, { status: "fast-forwarded", from: pushed });
  assert.equal(head(workspace), later);
  assert.equal(git(workspace, "symbolic-ref", "--short", "HEAD"), BRANCH, "still on the branch, not detached");
  assert.equal(await readFile(path.join(workspace, "retry.ts"), "utf8"), "export const backoff = 2;\n");
  assert.equal(git(workspace, "status", "--porcelain"), "");
});

test("a branch with uncommitted changes is never touched, not even fetched into", async (t) => {
  const { workspace, pushed, author, publishHead } = await withRepos(t);
  const later = await commit(author, "retry.ts", "export const backoff = 2;\n", "Back off between retries");
  publishHead(later);
  await writeFile(path.join(workspace, "upload.ts"), "export const retries = 5; // work in progress\n");

  const result = await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: later });

  assert.deepEqual(result, { status: "dirty" });
  assert.equal(head(workspace), pushed);
  assert.equal(await readFile(path.join(workspace, "upload.ts"), "utf8"), "export const retries = 5; // work in progress\n");
  assert.throws(() => git(workspace, "cat-file", "-e", `${later}^{commit}`), "the head was not fetched");
});

test("an untracked file makes a branch dirty too", async (t) => {
  const { workspace, pushed, author, publishHead } = await withRepos(t);
  const later = await commit(author, "retry.ts", "export const backoff = 2;\n", "Back off between retries");
  publishHead(later);
  await writeFile(path.join(workspace, "notes.md"), "an agent's scratch file\n");

  assert.deepEqual(await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: later }), {
    status: "dirty",
  });
  assert.equal(head(workspace), pushed);
});

test("a branch with commits the head does not have is left where it is", async (t) => {
  const { workspace, author, publishHead } = await withRepos(t);
  const later = await commit(author, "retry.ts", "export const backoff = 2;\n", "Back off between retries");
  publishHead(later);
  const local = await commit(workspace, "local.ts", "export const mine = true;\n", "Something of the reviewer's own");

  const result = await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: later });

  assert.deepEqual(result, { status: "diverged" });
  assert.equal(head(workspace), local);
});

test("a branch ahead of the head counts as diverged, since the guide would not read the head", async (t) => {
  const { workspace, pushed } = await withRepos(t);
  const local = await commit(workspace, "local.ts", "export const mine = true;\n", "Not pushed yet");

  assert.deepEqual(await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: pushed }), {
    status: "diverged",
  });
  assert.equal(head(workspace), local);
});

test("a checkout that has moved to another branch is left alone", async (t) => {
  const { workspace, pushed } = await withRepos(t);
  git(workspace, "switch", "--quiet", "-c", "something-else");

  assert.deepEqual(await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: pushed }), {
    status: "moved",
    branch: "something-else",
  });
});

test("a head that cannot be fetched fails in git's words and leaves the branch alone", async (t) => {
  const { workspace, pushed } = await withRepos(t);

  const missing = await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: "refs/pull/8/head", headSha: pushed });
  assert.equal(missing.status, "failed");
  assert.match(missing.status === "failed" ? missing.message : "", /^Could not fetch refs\/pull\/8\/head: couldn't find remote ref/);

  const elsewhere = await fastForward(run, { directory: workspace, branch: BRANCH, fetchRef: FETCH_REF, headSha: "f".repeat(40) });
  assert.deepEqual(elsewhere, { status: "failed", message: `${FETCH_REF} did not bring ffffffffffff with it.` });
  assert.equal(head(workspace), pushed);
});

test("commits the checkout lacks are fetched without moving a branch, and ones it has are not fetched", async (t) => {
  const { workspace, pushed, author, publishHead } = await withRepos(t);
  const later = await commit(author, "retry.ts", "export const backoff = 2;\n", "Back off between retries");
  publishHead(later);
  const remoteBranches = git(workspace, "branch", "--remotes");

  assert.equal(await fetchMissing(run, workspace, [{ sha: pushed, fetchRef: "refs/pull/8/head" }, { sha: later, fetchRef: FETCH_REF }]), null);
  assert.equal(git(workspace, "cat-file", "-t", later), "commit");
  assert.equal(head(workspace), pushed);
  assert.equal(git(workspace, "branch", "--remotes"), remoteBranches);
});

test("a commit that cannot be fetched says why", async (t) => {
  const { workspace } = await withRepos(t);

  assert.match((await fetchMissing(run, workspace, [{ sha: "f".repeat(40), fetchRef: "refs/pull/8/head" }])) ?? "", /^Could not fetch refs\/pull\/8\/head: couldn't find remote ref/);
  assert.equal(await fetchMissing(run, workspace, [{ sha: "f".repeat(40), fetchRef: FETCH_REF }]), `${FETCH_REF} did not bring ffffffffffff with it.`);
});
