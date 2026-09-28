import { z } from "zod";
import type { CommandRunner } from "../command-runner.ts";
import { createCli } from "./cli.ts";
import { ForgeError, type ChangedFileStatus, type ChangeRequest, type ChangeRequestRef, type ChangeRequestState, type Forge, type ForgeUser } from "./port.ts";

export const GITHUB_HOST = "github.com";

/** Cloning a large repository is the one call that can take minutes. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Enough to understand a PR; the guide does not need a hundred-and-first commit's message. */
const MAX_COMMITS = 100;
const MAX_LINKED_ISSUES = 25;

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

export type GitHubForgeOptions = {
  run: CommandRunner;
  /** The `gh` executable from the settings. */
  gh: () => Promise<string>;
};

export function createGitHubForge(options: GitHubForgeOptions): Forge {
  const gh = createCli({ run: options.run, binary: options.gh, name: "gh", env: GH_ENV });

  return {
    kind: "github",
    urlHint: "a GitHub pull request URL, like https://github.com/owner/repo/pull/123",

    async matchUrl(url) {
      return parsePullRequestUrl(url);
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
        author: pr.author ? { login: pr.author.login, name: pr.author.name ?? null } : GHOST,
        state: STATES[pr.state],
        isDraft: pr.isDraft,
        baseBranch: pr.baseRefName,
        headBranch: pr.headRefName,
        baseSha: pr.baseRefOid,
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

    async currentUser(ref): Promise<ForgeUser> {
      const user = await gh.json(UserResponse, ["api", "--hostname", ref.host, "user"]);
      return { login: user.login, name: user.name ?? null };
    },

    async cloneRepository(ref, directory) {
      // gh picks the protocol and credentials the reviewer set it up with, which `git clone` would not.
      await gh.text(["repo", "clone", `${ref.host}/${ref.project}`, directory], { timeoutMs: CLONE_TIMEOUT_MS });
    },
  };
}

const STATES: Record<"OPEN" | "CLOSED" | "MERGED", ChangeRequestState> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};

/** GitHub's name for the author of a PR whose account was deleted. */
const GHOST: ForgeUser = { login: "ghost", name: null };

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
