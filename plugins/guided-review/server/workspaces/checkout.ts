import type { CommandRequest, CommandResult, CommandRunner } from "../command-runner.ts";

/**
 * The git behind attaching a guide to the reviewer's own checkout: which branch it is on, where its
 * `origin` points, and a fast-forward to a change request's head that only ever happens to a clean
 * branch the head is ahead of. Anything else leaves the checkout exactly as it was.
 */

/** Reading a branch or a remote is local and quick. */
const LOCAL_TIMEOUT_MS = 10_000;
/** A fetch goes over the network, and a large change request's objects can take a while. */
const FETCH_TIMEOUT_MS = 120_000;

/**
 * No prompt for credentials the daemon cannot answer, and no optional locks: `git status` would
 * otherwise refresh the index under an agent working in the same checkout.
 */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

export type CheckoutState = {
  /** Null when HEAD is detached. */
  branch: string | null;
  /** `origin`'s URL, or null when there is no such remote. */
  origin: string | null;
};

export type FastForwardRequest = {
  directory: string;
  /** The branch the checkout has to still be on. */
  branch: string;
  /** Where the change request's head is fetched from on `origin`: `refs/pull/7/head`. */
  fetchRef: string;
  /** The head the guide is written for, which the branch is brought to. */
  headSha: string;
};

export type FastForwardResult =
  /** The branch was at the head already. */
  | { status: "current" }
  | { status: "fast-forwarded"; from: string }
  /** Left alone: it has changes that are not committed, untracked files included. */
  | { status: "dirty" }
  /** Left alone: it has commits the head does not. */
  | { status: "diverged" }
  /** Left alone: the checkout is no longer on the branch. */
  | { status: "moved"; branch: string | null }
  /** Left alone: git failed, in its words. */
  | { status: "failed"; message: string };

export async function readCheckout(run: CommandRunner, directory: string): Promise<CheckoutState> {
  const git = gitIn(run, directory);
  const [branch, origin] = await Promise.all([currentBranch(git), git(["remote", "get-url", "origin"])]);
  return { branch, origin: origin.exitCode === 0 ? origin.stdout.trim() || null : null };
}

/**
 * Brings `branch` to `headSha` when the checkout is on it, has nothing uncommitted, and the head
 * is ahead of it; otherwise touches nothing and says why. The head is fetched from `fetchRef`
 * into `FETCH_HEAD` only, so no remote-tracking branch moves either.
 */
export async function fastForward(run: CommandRunner, request: FastForwardRequest): Promise<FastForwardResult> {
  const git = gitIn(run, request.directory);

  const branch = await currentBranch(git);
  if (branch !== request.branch) return { status: "moved", branch };

  const status = await git(["status", "--porcelain"]);
  if (status.exitCode !== 0) return failed("Could not read the working tree", status);
  if (status.stdout.trim() !== "") return { status: "dirty" };

  const fetched = await git(["fetch", "--no-tags", "origin", request.fetchRef], FETCH_TIMEOUT_MS);
  if (fetched.exitCode !== 0) return failed(`Could not fetch ${request.fetchRef}`, fetched);
  const present = await git(["cat-file", "-e", `${request.headSha}^{commit}`]);
  if (present.exitCode !== 0) return { status: "failed", message: `${request.fetchRef} did not bring ${short(request.headSha)} with it.` };

  const head = await git(["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) return failed("Could not read HEAD", head);
  const from = head.stdout.trim();
  if (from === request.headSha) return { status: "current" };

  // Exit 0: HEAD is an ancestor of the head, so the move is a fast-forward. Exit 1: it is not.
  const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", request.headSha]);
  if (ancestor.exitCode === 1) return { status: "diverged" };
  if (ancestor.exitCode !== 0) return failed("Could not compare the branch with the head", ancestor);

  // `--ff-only` refuses rather than merges, and refuses to overwrite anything written since the check.
  const merged = await git(["merge", "--ff-only", "--no-edit", request.headSha]);
  if (merged.exitCode !== 0) return failed(`Could not fast-forward ${request.branch}`, merged);
  return { status: "fast-forwarded", from };
}

export type WantedCommit = {
  sha: string;
  /** Where on `origin` a fetch brings it: `refs/pull/7/head`, or the branch it is on. */
  fetchRef: string;
};

/**
 * Fetches each of `commits` the checkout's repository lacks from its `fetchRef` on `origin`, into
 * `FETCH_HEAD` only, so no branch moves. Null once all of them are there, else why one is not.
 */
export async function fetchMissing(run: CommandRunner, directory: string, commits: readonly WantedCommit[]): Promise<string | null> {
  const git = gitIn(run, directory);
  const present = async (sha: string) => (await git(["cat-file", "-e", `${sha}^{commit}`])).exitCode === 0;
  for (const commit of commits) {
    if (await present(commit.sha)) continue;
    const fetched = await git(["fetch", "--no-tags", "origin", commit.fetchRef], FETCH_TIMEOUT_MS);
    if (fetched.exitCode !== 0) return failedMessage(`Could not fetch ${commit.fetchRef}`, fetched);
    if (!(await present(commit.sha))) return `${commit.fetchRef} did not bring ${short(commit.sha)} with it.`;
  }
  return null;
}

/** A file's text at `sha`, its path from the repository's root; null when git cannot show it, as for a commit the clone lacks. */
export async function showFile(run: CommandRunner, directory: string, sha: string, path: string): Promise<string | null> {
  const shown = await gitIn(run, directory)(["show", `${sha}:${path}`]);
  return shown.exitCode === 0 ? shown.stdout : null;
}

type Git = (args: readonly string[], timeoutMs?: number) => Promise<CommandResult>;

function gitIn(run: CommandRunner, directory: string): Git {
  return (args, timeoutMs = LOCAL_TIMEOUT_MS) => {
    const request: CommandRequest = { file: "git", args: ["-C", directory, ...args], env: GIT_ENV, timeoutMs };
    return run(request);
  };
}

async function currentBranch(git: Git): Promise<string | null> {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function failed(context: string, result: CommandResult): FastForwardResult {
  return { status: "failed", message: failedMessage(context, result) };
}

function failedMessage(context: string, result: CommandResult): string {
  const reason = result.spawnError ?? firstLine(result.stderr) ?? `exit code ${result.exitCode}`;
  return `${context}: ${reason.replace(/^(fatal|error): /, "")}`;
}

/** git says what went wrong first, and follows it with hints. */
function firstLine(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("hint:"));
  return lines[0] ?? null;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
