import { z } from "zod";
import type { CommandRunner } from "../command-runner.ts";
import { oneAtATimePer } from "../one-at-a-time.ts";
import { createCli } from "./cli.ts";
import type { Draft, DraftLocation } from "../../shared/drafts.ts";
import type { Verdict } from "../../shared/submit.ts";
import { CLONE_TIMEOUT_MS, MAX_BRANCH_CHANGE_REQUESTS, MAX_COMMITS, MAX_LINKED_ISSUES, userOf } from "./common.ts";
import { SubmitSteps } from "./submit-steps.ts";
import {
  ForgeError,
  type AnchorLine,
  type BranchChangeRequest,
  type ChangedFileStatus,
  type ChangeRequest,
  type ChangeRequestHead,
  type ChangeRequestRef,
  type ChangeRequestState,
  type DraftAnchor,
  type DraftTarget,
  type Forge,
  type ForgeUser,
} from "./port.ts";

export const GITHUB_HOST = "github.com";

/** No prompts, no update nags and no colour codes: the output is parsed, not read. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/**
 * One query for the metadata, the commits and the linked issues. `closingIssuesReferences` is the
 * only place GitHub gives linked issues their titles and bodies in the same round trip.
 */
export const PULL_REQUEST_QUERY = `query GuidedReviewPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title body state isDraft
      author { login ... on User { name } }
      baseRefName baseRefOid headRefName headRefOid
      additions deletions changedFiles
      commits(first: ${MAX_COMMITS}) { totalCount nodes { commit { oid messageHeadline messageBody authoredDate author { name user { login } } } } }
      closingIssuesReferences(first: ${MAX_LINKED_ISSUES}) { nodes { number url title body state } }
    }
  }
}`;

const PullRequestResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            title: z.string(),
            body: z.string(),
            state: z.enum(["OPEN", "CLOSED", "MERGED"]),
            isDraft: z.boolean(),
            author: z.object({ login: z.string(), name: z.string().nullish() }).nullable(),
            baseRefName: z.string(),
            baseRefOid: z.string(),
            headRefName: z.string(),
            headRefOid: z.string(),
            additions: z.number(),
            deletions: z.number(),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    oid: z.string(),
                    messageHeadline: z.string(),
                    messageBody: z.string(),
                    authoredDate: z.string(),
                    author: z.object({ name: z.string().nullish(), user: z.object({ login: z.string() }).nullish() }).nullish(),
                  }),
                }),
              ),
            }),
            closingIssuesReferences: z.object({
              nodes: z.array(
                z.object({ number: z.number(), url: z.string(), title: z.string(), body: z.string(), state: z.string() }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/** Only where the head is and whether the PR is still open, for noticing a push without reading the PR again. */
export const PULL_REQUEST_HEAD_QUERY = `query GuidedReviewPullRequestHead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid state }
  }
}`;

const PullRequestHeadResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z.object({ headRefOid: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]) }).nullable(),
      })
      .nullable(),
  }),
});

const FilesResponse = z.array(
  z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
);

const UserResponse = z.object({ login: z.string(), name: z.string().nullish() });

const BranchPullRequestsResponse = z.array(
  z.object({
    number: z.number(),
    url: z.string(),
    title: z.string(),
    author: z.object({ login: z.string() }).nullable(),
    headRefOid: z.string(),
  }),
);

/**
 * A pending review is visible only to its author and GitHub allows one per user and PR, so the
 * first pending review is the viewer's own, whether this plugin or github.com started it.
 */
export const PENDING_REVIEW_QUERY = `query GuidedReviewPendingReview($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      reviews(states: PENDING, first: 1) { nodes { id viewerDidAuthor } }
    }
  }
}`;

/** No `event`, so the review stays pending: nothing is published until it is submitted. */
export const START_REVIEW_MUTATION = `mutation GuidedReviewStartReview($pullRequestId: ID!, $commitOID: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
    pullRequestReview { id }
  }
}`;

/** What a draft's location is read from: a comment carries no side, only its thread does. */
const THREAD_FIELDS = "path line originalLine startLine originalStartLine diffSide startDiffSide subjectType";

export const ADD_THREAD_MUTATION = `mutation GuidedReviewAddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) {
    thread { ${THREAD_FIELDS} comments(first: 1) { nodes { id body } } }
  }
}`;

export const UPDATE_COMMENT_MUTATION = `mutation GuidedReviewUpdateDraft($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

export const DELETE_COMMENT_MUTATION = `mutation GuidedReviewDeleteDraft($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) {
    pullRequestReviewComment { id }
  }
}`;

/** Threads are paged through; a thread's pending comments are the viewer's drafts in it, replies included. */
const MAX_THREADS = 100;
const MAX_THREAD_COMMENTS = 100;

export const DRAFTS_QUERY = `query GuidedReviewDrafts($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(states: PENDING, first: 1) { nodes { id viewerDidAuthor } }
      reviewThreads(first: ${MAX_THREADS}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} comments(first: ${MAX_THREAD_COMMENTS}) { nodes { id body pullRequestReview { id } } } }
      }
    }
  }
}`;

const PendingReviews = z.object({ nodes: z.array(z.object({ id: z.string(), viewerDidAuthor: z.boolean() })) });

const PendingReviewResponse = z.object({
  data: z.object({
    repository: z.object({ pullRequest: z.object({ id: z.string(), reviews: PendingReviews }).nullable() }).nullable(),
  }),
});

const DiffSide = z.enum(["LEFT", "RIGHT"]);

const Thread = z.object({
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  startLine: z.number().nullable(),
  originalStartLine: z.number().nullable(),
  diffSide: DiffSide,
  startDiffSide: DiffSide.nullable(),
  subjectType: z.enum(["LINE", "FILE"]).nullish(),
});

const StartReviewResponse = z.object({
  data: z.object({ addPullRequestReview: z.object({ pullRequestReview: z.object({ id: z.string() }) }) }),
});

const AddThreadResponse = z.object({
  data: z.object({
    addPullRequestReviewThread: z.object({
      thread: Thread.extend({ comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string() })) }) }).nullable(),
    }),
  }),
});

const DraftsResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            reviews: PendingReviews,
            reviewThreads: z.object({
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
              nodes: z.array(
                Thread.extend({
                  comments: z.object({
                    nodes: z.array(
                      z.object({ id: z.string(), body: z.string(), pullRequestReview: z.object({ id: z.string() }).nullable() }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/** Publishes the pending review, every comment on it included, with its body and verdict. */
export const SUBMIT_REVIEW_MUTATION = `mutation GuidedReviewSubmit($id: ID!, $event: PullRequestReviewEvent!, $body: String!) {
  submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) {
    pullRequestReview { id state }
  }
}`;

/** Deletes the pending review, and with it every comment on it. */
export const DELETE_REVIEW_MUTATION = `mutation GuidedReviewDiscard($id: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $id }) {
    pullRequestReview { id }
  }
}`;

const EVENTS: Record<Verdict, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
};

const SUBMIT_LABELS: Record<Verdict, string> = {
  approve: "Publish the review and approve",
  "request-changes": "Publish the review and request changes",
  comment: "Publish the review as a comment",
};

/** Any mutation whose answer is only read for its errors, which `gh` turns into a failed exit. */
const MutationResponse = z.object({ data: z.unknown() });

export type GitHubForgeOptions = {
  run: CommandRunner;
  /** The `gh` executable from the settings. */
  gh: () => Promise<string>;
};

export function createGitHubForge(options: GitHubForgeOptions): Forge {
  const gh = createCli({ run: options.run, binary: options.gh, name: "gh", env: GH_ENV });

  /** A GraphQL request, its variables in a JSON body on stdin so none is retyped. */
  const graphql = <Schema extends z.ZodType>(ref: ChangeRequestRef, schema: Schema, query: string, variables: Record<string, unknown>) =>
    gh.json(schema, ["api", "graphql", "--hostname", ref.host, "--input", "-"], { input: JSON.stringify({ query, variables }) });

  const pullRequestVariables = (ref: ChangeRequestRef) => {
    const [owner, name] = ref.project.split("/") as [string, string];
    return { owner, name, number: ref.number };
  };

  /**
   * The viewer's pending review, started on `target`'s head when there is none. Two drafts saved at
   * once would otherwise both find none and start two, and GitHub turns the second down. A submit
   * and a discard queue here too, so neither acts on a review another is starting.
   */
  const creating = oneAtATimePer<string>();
  const oneAtATime = <T>(ref: ChangeRequestRef, run: () => Promise<T>): Promise<T> => creating(ref.url, run);

  /** The pull request's node ID and the viewer's pending review on it, if any. */
  const findPendingReview = async (ref: ChangeRequestRef): Promise<{ pullRequestId: string; reviewId: string | null }> => {
    const response = await graphql(ref, PendingReviewResponse, PENDING_REVIEW_QUERY, pullRequestVariables(ref));
    const pr = response.data.repository?.pullRequest;
    if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
    return { pullRequestId: pr.id, reviewId: pr.reviews.nodes.find((review) => review.viewerDidAuthor)?.id ?? null };
  };

  const pendingReview = async (target: DraftTarget): Promise<string> => {
    const { pullRequestId, reviewId } = await findPendingReview(target.ref);
    if (reviewId !== null) return reviewId;
    const started = await graphql(target.ref, StartReviewResponse, START_REVIEW_MUTATION, {
      pullRequestId,
      commitOID: target.headSha,
    });
    return started.data.addPullRequestReview.pullRequestReview.id;
  };

  return {
    kind: "github",
    urlHint: "a GitHub pull request URL, like https://github.com/owner/repo/pull/123",

    async matchUrl(url) {
      return parsePullRequestUrl(url);
    },

    async findByBranch(repository, branch): Promise<BranchChangeRequest[] | null> {
      if (repository.host.toLowerCase().replace(/^www\./, "") !== GITHUB_HOST) return null;
      // `--head` takes a branch name only, so a fork's PR from a branch of the same name is found too;
      // the fast-forward, which fetches the PR's own ref, is what tells them apart.
      const pullRequests = await gh.json(BranchPullRequestsResponse, [
        "pr",
        "list",
        "--repo",
        `${GITHUB_HOST}/${repository.project}`,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,title,author,headRefOid",
        "--limit",
        String(MAX_BRANCH_CHANGE_REQUESTS),
      ]);
      return pullRequests.flatMap((pr) => {
        const ref = parsePullRequestUrl(pr.url);
        return ref === null ? [] : [{ ref, title: pr.title, author: userOf(pr.author).login, headSha: pr.headRefOid }];
      });
    },

    async fetchChangeRequest(ref) {
      const [owner, name] = ref.project.split("/") as [string, string];
      // Variables go in a JSON body on stdin: `-F` would turn a repository called `123` into a number.
      const input = JSON.stringify({ query: PULL_REQUEST_QUERY, variables: { owner, name, number: ref.number } });
      const response = await gh.json(PullRequestResponse, ["api", "graphql", "--hostname", ref.host, "--input", "-"], { input });
      const pr = response.data.repository?.pullRequest;
      if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);

      // The REST listing is the authoritative one, and the only one that carries each file's patch.
      const files = await gh.json(FilesResponse, [
        "api",
        "--hostname",
        ref.host,
        `repos/${ref.project}/pulls/${ref.number}/files?per_page=100`,
        "--paginate",
      ]);

      return {
        ref,
        title: pr.title,
        description: pr.body,
        author: userOf(pr.author),
        state: STATES[pr.state],
        isDraft: pr.isDraft,
        baseBranch: pr.baseRefName,
        headBranch: pr.headRefName,
        baseSha: pr.baseRefOid,
        startSha: pr.baseRefOid,
        headSha: pr.headRefOid,
        additions: pr.additions,
        deletions: pr.deletions,
        commits: pr.commits.nodes.map(({ commit }) => ({
          sha: commit.oid,
          headline: commit.messageHeadline,
          body: commit.messageBody,
          author: commit.author?.user?.login ?? commit.author?.name ?? "unknown",
          authoredAt: commit.authoredDate,
        })),
        linkedIssues: pr.closingIssuesReferences.nodes.map((issue) => ({ ...issue })),
        files: files.map((file) => ({
          path: file.filename,
          previousPath: file.previous_filename ?? null,
          status: file.status satisfies ChangedFileStatus,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
      } satisfies ChangeRequest;
    },

    async fetchHead(ref): Promise<ChangeRequestHead> {
      const [owner, name] = ref.project.split("/") as [string, string];
      const input = JSON.stringify({ query: PULL_REQUEST_HEAD_QUERY, variables: { owner, name, number: ref.number } });
      const response = await gh.json(PullRequestHeadResponse, ["api", "graphql", "--hostname", ref.host, "--input", "-"], { input });
      const pr = response.data.repository?.pullRequest;
      if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
      return { headSha: pr.headRefOid, state: STATES[pr.state] };
    },

    async currentUser(ref): Promise<ForgeUser> {
      const user = await gh.json(UserResponse, ["api", "--hostname", ref.host, "user"]);
      return { login: user.login, name: user.name ?? null };
    },

    async cloneRepository(ref, directory) {
      // gh picks the protocol and credentials the reviewer set it up with, which `git clone` would not.
      await gh.text(["repo", "clone", `${ref.host}/${ref.project}`, directory], { timeoutMs: CLONE_TIMEOUT_MS });
    },

    async listDrafts(ref) {
      const drafts: Draft[] = [];
      let after: string | null = null;
      for (;;) {
        const response: z.output<typeof DraftsResponse> = await graphql(ref, DraftsResponse, DRAFTS_QUERY, {
          ...pullRequestVariables(ref),
          after,
        });
        const pr = response.data.repository?.pullRequest;
        if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
        const review = pr.reviews.nodes.find((candidate) => candidate.viewerDidAuthor);
        if (!review) return [];
        for (const thread of pr.reviewThreads.nodes) {
          for (const comment of thread.comments.nodes) {
            if (comment.pullRequestReview?.id === review.id) drafts.push({ id: comment.id, body: comment.body, location: locationOf(thread) });
          }
        }
        const { hasNextPage, endCursor } = pr.reviewThreads.pageInfo;
        if (!hasNextPage || endCursor === null) return drafts;
        after = endCursor;
      }
    },

    async createDraft(target, { anchor, body }) {
      // A pending review has no comment on the pull request as a whole, only its body, which the service keeps.
      if (anchor.kind === "general") throw new ForgeError("GitHub keeps a comment on the pull request as a whole in the review body, not as a draft.");
      return oneAtATime(target.ref, async () => {
        const pullRequestReviewId = await pendingReview(target);
        const input = { pullRequestReviewId, path: anchor.path, body, ...threadAnchor(anchor) };
        const response = await graphql(target.ref, AddThreadResponse, ADD_THREAD_MUTATION, { input });
        const thread = response.data.addPullRequestReviewThread.thread;
        const comment = thread?.comments.nodes[0];
        if (!thread || !comment) throw new ForgeError("GitHub did not add the comment to your pending review.");
        return { id: comment.id, body: comment.body, location: locationOf(thread) };
      });
    },

    async updateDraft(ref, draftId, body) {
      await graphql(ref, MutationResponse, UPDATE_COMMENT_MUTATION, { id: draftId, body });
    },

    async deleteDraft(ref, draftId) {
      await graphql(ref, MutationResponse, DELETE_COMMENT_MUTATION, { id: draftId });
    },

    // GitHub refuses to edit a pending review's body while it is empty, as it is on every review started without one.
    takesGeneralDrafts: false,

    async postComment(ref, body) {
      // A pull request's conversation is its issue's, so a comment on it as a whole is an issue comment.
      await gh.text(["api", "--hostname", ref.host, "--method", "POST", `repos/${ref.project}/issues/${ref.number}/comments`, "--input", "-"], {
        input: JSON.stringify({ body }),
      });
    },

    async submitReview(target, { verdict, body }) {
      return oneAtATime(target.ref, async () => {
        // One mutation publishes the comments, the body and the verdict together, so it lands whole or not at all.
        const steps = new SubmitSteps();
        const submitted = await steps.run("submit", SUBMIT_LABELS[verdict], async () => {
          const id = await pendingReview(target);
          await graphql(target.ref, MutationResponse, SUBMIT_REVIEW_MUTATION, { id, event: EVENTS[verdict], body });
        });
        return { published: submitted.ok, steps: steps.steps };
      });
    },

    async discardReview(ref) {
      await oneAtATime(ref, async () => {
        const { reviewId } = await findPendingReview(ref);
        if (reviewId !== null) await graphql(ref, MutationResponse, DELETE_REVIEW_MUTATION, { id: reviewId });
      });
    },
  };
}

type GitHubSide = z.output<typeof DiffSide>;

/**
 * Where a thread goes, in `AddPullRequestReviewThreadInput`'s fields: a removed line on the LEFT
 * side by its old number, any other line on the RIGHT by its new one; a range's first line in
 * `startLine`/`startSide` and its last in `line`/`side`; a file as subject type FILE with no line.
 */
function threadAnchor(anchor: Exclude<DraftAnchor, { kind: "general" }>): Record<string, string | number> {
  const point = (line: AnchorLine): { line: number; side: GitHubSide } =>
    line.kind === "removed" ? { line: line.oldLine!, side: "LEFT" } : { line: line.newLine!, side: "RIGHT" };
  switch (anchor.kind) {
    case "line":
      return { subjectType: "LINE", ...point(anchor.line) };
    case "range": {
      const start = point(anchor.start);
      return { subjectType: "LINE", startLine: start.line, startSide: start.side, ...point(anchor.end) };
    }
    case "file":
      return { subjectType: "FILE" };
  }
}

/** A thread's place as a `DraftLocation`; an outdated thread, which has no current line, by its original one. */
function locationOf(thread: z.output<typeof Thread>): DraftLocation {
  const { path } = thread;
  const current = thread.line !== null;
  const endLine = current ? thread.line : thread.originalLine;
  const startLine = current ? thread.startLine : thread.originalStartLine;
  if (thread.subjectType === "FILE" || endLine === null) return { kind: "file", path };
  const end = { side: sideOf(thread.diffSide), line: endLine };
  if (startLine === null) return { kind: "line", path, line: end };
  const start = { side: sideOf(thread.startDiffSide ?? thread.diffSide), line: startLine };
  if (start.side === end.side && start.line === end.line) return { kind: "line", path, line: end };
  return { kind: "range", path, start, end };
}

function sideOf(side: GitHubSide): "old" | "new" {
  return side === "LEFT" ? "old" : "new";
}

const STATES: Record<"OPEN" | "CLOSED" | "MERGED", ChangeRequestState> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * A pull request URL on github.com, with or without its scheme and with whatever tab or anchor it
 * was copied from; anything else is null.
 */
export function parsePullRequestUrl(text: string): ChangeRequestRef | null {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== GITHUB_HOST) return null;

  const [owner, repo, kind, number] = url.pathname.split("/").filter((segment) => segment !== "");
  if (owner === undefined || repo === undefined || kind !== "pull" || number === undefined) return null;
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith(".") || repo.startsWith(".")) return null;
  if (!/^[1-9]\d{0,9}$/.test(number)) return null;

  const project = `${owner}/${repo}`;
  return {
    forge: "github",
    host,
    project,
    number: Number(number),
    url: `https://${host}/${project}/pull/${number}`,
  };
}
